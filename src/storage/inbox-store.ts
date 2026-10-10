import { readdir } from 'node:fs/promises';
import { assertMember, type Member } from '../domain/member.ts';
import { assertEnvelope, MAX_MESSAGE_BODY_BYTES, messageExpired, type Envelope } from '../domain/message.ts';
import { assertTeam, assertEntityId, assertTeamId } from '../domain/team.ts';
import {
  createAtomicJson, ensurePrivateDirectory, ensurePrivateTree, jsonFileNames, moveAtomic, readJson, removeAtomic,
  withStorageLock,
} from './atomic.ts';
import { TeamPaths } from './paths.ts';

// JSON escaping can expand a valid 8 KiB control-character body to six bytes
// per input byte, so the record cap must bound metadata without rejecting it.
/** Room for the largest body with every character JSON-escaped (6 bytes each), plus the envelope. */
const MESSAGE_MAX_BYTES = 7 * MAX_MESSAGE_BODY_BYTES;
const TEAM_MAX_BYTES = 32 * 1024;
const MEMBER_MAX_BYTES = 64 * 1024;

export type InboxStoreOptions = {
  readonly recipientQuota?: number;
  readonly teamQuota?: number;
  readonly now?: () => number;
};

export type InboxPage = {
  readonly messages: readonly Envelope[];
  readonly nextCursor?: string;
};

export class InboxStore {
  private readonly recipientQuota: number;
  private readonly teamQuota: number;
  private readonly now: () => number;

  constructor(readonly paths: TeamPaths, options: InboxStoreOptions = {}) {
    this.recipientQuota = options.recipientQuota ?? 100;
    this.teamQuota = options.teamQuota ?? 1_000;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.recipientQuota) || this.recipientQuota < 1 ||
        !Number.isSafeInteger(this.teamQuota) || this.teamQuota < this.recipientQuota) {
      throw new Error('Invalid inbox quotas.');
    }
  }

  private async prepare(): Promise<void> {
    await ensurePrivateTree(this.paths.root, 'teams');
    await ensurePrivateTree(this.paths.root, 'control');
  }

  private async requireTeam(teamId: string, requireOpen = false): Promise<void> {
    try {
      await ensurePrivateDirectory(this.paths.team(teamId), false);
      await ensurePrivateDirectory(this.paths.members(teamId), false);
      await ensurePrivateDirectory(this.paths.inbox(teamId), false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw Object.assign(new Error(`Unknown team "${teamId}".`), { code: 'NOT_FOUND' });
      }
      throw error;
    }
    const team = await readJson(this.paths.teamRecord(teamId), assertTeam, TEAM_MAX_BYTES);
    if (!team) throw Object.assign(new Error(`Team "${teamId}" is incomplete.`), { code: 'NOT_FOUND' });
    if (requireOpen && team.state !== 'open') {
      throw Object.assign(new Error(`Team "${teamId}" is ${team.state}.`), { code: 'TEAM_CLOSED' });
    }
  }

  private async member(teamId: string, memberId: string): Promise<Member> {
    await ensurePrivateDirectory(this.paths.members(teamId), false);
    const member = await readJson(this.paths.member(teamId, memberId), assertMember, MEMBER_MAX_BYTES);
    if (!member || member.teamId !== teamId || member.memberId !== memberId) {
      throw Object.assign(new Error(`Unknown member "${memberId}".`), { code: 'NOT_FOUND' });
    }
    return member;
  }

  private async prepareRecipient(teamId: string, memberId: string, create: boolean): Promise<boolean> {
    try {
      await ensurePrivateDirectory(this.paths.inbox(teamId), false);
      await ensurePrivateDirectory(this.paths.memberInbox(teamId, memberId), create);
      await ensurePrivateDirectory(this.paths.pending(teamId, memberId), create);
      await ensurePrivateDirectory(this.paths.claimed(teamId, memberId), create);
      return true;
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async memberCount(teamId: string, memberId: string): Promise<number> {
    if (!await this.prepareRecipient(teamId, memberId, false)) return 0;
    const [pending, claimed] = await Promise.all([
      jsonFileNames(this.paths.pending(teamId, memberId), false),
      jsonFileNames(this.paths.claimed(teamId, memberId), false),
    ]);
    return pending.length + claimed.length;
  }

  private async inboxMemberIds(teamId: string): Promise<string[]> {
    const entries = await readdir(this.paths.inbox(teamId), { withFileTypes: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    return entries
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
      .map(entry => entry.name)
      .filter(memberId => {
        try { assertEntityId(memberId, 'member ID'); return true; }
        catch { return false; }
      });
  }

  private async teamCount(teamId: string): Promise<number> {
    const counts = await Promise.all((await this.inboxMemberIds(teamId)).map(memberId => this.memberCount(teamId, memberId)));
    return counts.reduce((sum, count) => sum + count, 0);
  }

  private async teamHasMessage(teamId: string, messageId: string): Promise<boolean> {
    const matches = await Promise.all((await this.inboxMemberIds(teamId)).map(async memberId => {
      if (!await this.prepareRecipient(teamId, memberId, false)) return false;
      const [pending, claimed] = await Promise.all([
        jsonFileNames(this.paths.pending(teamId, memberId), false),
        jsonFileNames(this.paths.claimed(teamId, memberId), false),
      ]);
      return pending.includes(messageId) || claimed.includes(messageId);
    }));
    return matches.some(Boolean);
  }

  private assertStoredMessage(message: Envelope, teamId: string, recipientId: string, messageId?: string): void {
    if (message.teamId !== teamId || message.toMemberId !== recipientId || (messageId && message.messageId !== messageId)) {
      throw Object.assign(new Error('Message identity does not match its storage path.'), { code: 'CORRUPT_RECORD' });
    }
  }

  async enqueue(message: Envelope): Promise<void> {
    assertEnvelope(message);
    await this.prepare();
    await withStorageLock(this.paths.inboxLock(message.teamId), async () => {
      await this.requireTeam(message.teamId, true);
      if (messageExpired(message, this.now())) throw Object.assign(new Error('Message has already expired.'), { code: 'EXPIRED' });
      const [sender, recipient] = await Promise.all([
        this.member(message.teamId, message.fromMemberId),
        this.member(message.teamId, message.toMemberId),
      ]);
      if (sender.generation !== message.senderGeneration ||
          (message.recipientGeneration !== undefined && recipient.generation !== message.recipientGeneration)) {
        throw Object.assign(new Error('Message generation has been fenced.'), { code: 'FENCED' });
      }
      const [recipientCount, teamCount, duplicate] = await Promise.all([
        this.memberCount(message.teamId, message.toMemberId),
        this.teamCount(message.teamId),
        this.teamHasMessage(message.teamId, message.messageId),
      ]);
      if (duplicate) throw Object.assign(new Error(`Message "${message.messageId}" already exists.`), { code: 'ALREADY_EXISTS' });
      if (recipientCount >= this.recipientQuota) {
        throw Object.assign(new Error(`Recipient inbox quota reached (${this.recipientQuota}).`), { code: 'QUOTA_EXCEEDED' });
      }
      if (teamCount >= this.teamQuota) {
        throw Object.assign(new Error(`Team inbox quota reached (${this.teamQuota}).`), { code: 'QUOTA_EXCEEDED' });
      }
      await this.prepareRecipient(message.teamId, message.toMemberId, true);
      await createAtomicJson(
        this.paths.pendingMessage(message.teamId, message.toMemberId, message.messageId),
        message,
        MESSAGE_MAX_BYTES,
      );
    });
  }

  async readPending(teamId: string, recipientId: string, messageId: string): Promise<Envelope | undefined> {
    await this.prepare();
    await this.requireTeam(teamId);
    if (!await this.prepareRecipient(teamId, recipientId, false)) return undefined;
    const message = await readJson(this.paths.pendingMessage(teamId, recipientId, messageId), assertEnvelope, MESSAGE_MAX_BYTES);
    if (message) this.assertStoredMessage(message, teamId, recipientId, messageId);
    return message;
  }

  async readClaimed(teamId: string, recipientId: string, messageId: string): Promise<Envelope | undefined> {
    await this.prepare();
    await this.requireTeam(teamId);
    if (!await this.prepareRecipient(teamId, recipientId, false)) return undefined;
    const message = await readJson(this.paths.claimedMessage(teamId, recipientId, messageId), assertEnvelope, MESSAGE_MAX_BYTES);
    if (message) this.assertStoredMessage(message, teamId, recipientId, messageId);
    return message;
  }

  async listPending(teamId: string, recipientId: string, limit = 50, cursor?: string): Promise<InboxPage> {
    assertTeamId(teamId);
    assertEntityId(recipientId, 'recipient ID');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Inbox page limit must be between 1 and 100.');
    if (cursor !== undefined) assertEntityId(cursor, 'inbox cursor');
    await this.prepare();
    await this.requireTeam(teamId);
    if (!await this.prepareRecipient(teamId, recipientId, false)) return { messages: [] };
    const ids = await jsonFileNames(this.paths.pending(teamId, recipientId), false);
    const remaining = cursor === undefined ? ids : ids.filter(id => id > cursor);
    const pageIds = remaining.slice(0, limit);
    const records = await Promise.all(pageIds.map(id => this.readPending(teamId, recipientId, id)));
    const messages = records.filter((message): message is Envelope => message !== undefined);
    const nextCursor = remaining.length > limit ? pageIds.at(-1) : undefined;
    return { messages, ...(nextCursor ? { nextCursor } : {}) };
  }

  async listClaimed(teamId: string, recipientId: string, limit = 50, cursor?: string): Promise<InboxPage> {
    assertTeamId(teamId);
    assertEntityId(recipientId, 'recipient ID');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Inbox page limit must be between 1 and 100.');
    if (cursor !== undefined) assertEntityId(cursor, 'inbox cursor');
    await this.prepare();
    await this.requireTeam(teamId);
    if (!await this.prepareRecipient(teamId, recipientId, false)) return { messages: [] };
    const ids = await jsonFileNames(this.paths.claimed(teamId, recipientId), false);
    const remaining = cursor === undefined ? ids : ids.filter(id => id > cursor);
    const pageIds = remaining.slice(0, limit);
    const records = await Promise.all(pageIds.map(id => this.readClaimed(teamId, recipientId, id)));
    const messages = records.filter((message): message is Envelope => message !== undefined);
    const nextCursor = remaining.length > limit ? pageIds.at(-1) : undefined;
    return { messages, ...(nextCursor ? { nextCursor } : {}) };
  }

  async claim(teamId: string, recipientId: string, messageId: string): Promise<Envelope> {
    await this.prepare();
    return withStorageLock(this.paths.inboxLock(teamId), async () => {
      await this.requireTeam(teamId, true);
      const message = await this.readPending(teamId, recipientId, messageId);
      if (!message) throw Object.assign(new Error(`Unknown pending message "${messageId}".`), { code: 'NOT_FOUND' });
      if (messageExpired(message, this.now())) throw Object.assign(new Error('Message has expired.'), { code: 'EXPIRED' });
      await this.prepareRecipient(teamId, recipientId, true);
      await moveAtomic(
        this.paths.pendingMessage(teamId, recipientId, messageId),
        this.paths.claimedMessage(teamId, recipientId, messageId),
      );
      return message;
    });
  }

  async release(teamId: string, recipientId: string, messageId: string): Promise<void> {
    await this.prepare();
    await withStorageLock(this.paths.inboxLock(teamId), async () => {
      await this.requireTeam(teamId);
      const message = await readJson(
        this.paths.claimedMessage(teamId, recipientId, messageId), assertEnvelope, MESSAGE_MAX_BYTES,
      );
      if (!message) throw Object.assign(new Error(`Unknown claimed message "${messageId}".`), { code: 'NOT_FOUND' });
      this.assertStoredMessage(message, teamId, recipientId, messageId);
      await this.prepareRecipient(teamId, recipientId, true);
      await moveAtomic(
        this.paths.claimedMessage(teamId, recipientId, messageId),
        this.paths.pendingMessage(teamId, recipientId, messageId),
      );
    });
  }

  async removePending(teamId: string, recipientId: string, messageId: string): Promise<boolean> {
    await this.prepare();
    return withStorageLock(this.paths.inboxLock(teamId), async () => {
      await this.requireTeam(teamId);
      if (!await this.prepareRecipient(teamId, recipientId, false)) return false;
      return removeAtomic(this.paths.pendingMessage(teamId, recipientId, messageId));
    });
  }

  async removeClaimed(teamId: string, recipientId: string, messageId: string): Promise<boolean> {
    await this.prepare();
    return withStorageLock(this.paths.inboxLock(teamId), async () => {
      await this.requireTeam(teamId);
      if (!await this.prepareRecipient(teamId, recipientId, false)) return false;
      return removeAtomic(this.paths.claimedMessage(teamId, recipientId, messageId));
    });
  }

  async purgeExpired(teamId: string, recipientId: string): Promise<number> {
    await this.prepare();
    return withStorageLock(this.paths.inboxLock(teamId), async () => {
      await this.requireTeam(teamId);
      if (!await this.prepareRecipient(teamId, recipientId, false)) return 0;
      const directories = [this.paths.pending(teamId, recipientId), this.paths.claimed(teamId, recipientId)];
      const idsByDirectory = await Promise.all(directories.map(path => jsonFileNames(path, false)));
      const candidates = directories.flatMap((path, index) => idsByDirectory[index].map(id => ({ path, id })));
      const expired = (await Promise.all(candidates.map(async candidate => {
        const message = await readJson(`${candidate.path}/${candidate.id}.json`, assertEnvelope, MESSAGE_MAX_BYTES);
        if (!message) return undefined;
        this.assertStoredMessage(message, teamId, recipientId, candidate.id);
        return messageExpired(message, this.now()) ? candidate : undefined;
      }))).filter((candidate): candidate is { path: string; id: string } => candidate !== undefined);
      await Promise.all(expired.map(candidate => removeAtomic(`${candidate.path}/${candidate.id}.json`)));
      return expired.length;
    });
  }
}
