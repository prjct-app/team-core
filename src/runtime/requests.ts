import { createHash, randomUUID } from 'node:crypto';
import type { Envelope, MessageKind, Receipt } from '../domain/message.ts';
import { MAX_MESSAGE_TTL_MS, messageExpired } from '../domain/message.ts';
import type { RequestState } from '../domain/request.ts';
import { withStorageLock } from '../storage/atomic.ts';
import { InboxStore, type InboxPage } from '../storage/inbox-store.ts';
import { TeamPaths } from '../storage/paths.ts';
import { ReceiptStore } from '../storage/receipt-store.ts';
import { TeamStore } from '../storage/team-store.ts';
import { DeliveryService } from './delivery.ts';
import { MembershipService, type Membership } from './membership.ts';

const sendKinds = new Set<MessageKind>(['info', 'question', 'proposal', 'handoff', 'blocker', 'request']);
export type RequestRuntimeState = RequestState | 'failed';
const terminalRequestStates = new Set<RequestRuntimeState>(['replied', 'cancelled', 'expired', 'failed']);

export type ReplyResult = {
  readonly accepted: boolean;
  readonly message?: Envelope;
  readonly reason?: 'cancelled' | 'expired' | 'failed' | 'sender-replaced';
};

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

export class RequestService {
  private readonly now: () => number;

  constructor(
    private readonly paths: TeamPaths,
    private readonly teams: TeamStore,
    private readonly memberships: MembershipService,
    private readonly delivery: DeliveryService,
    private readonly inbox: InboxStore,
    private readonly receipts: ReceiptStore,
    now: () => number = Date.now,
  ) {
    this.now = now;
  }

  private lockPath(teamId: string, requestId: string): string {
    return this.paths.lock(`request-${createHash('sha256').update(`${teamId}\0${requestId}`).digest('hex')}`);
  }

  private async enqueueIdempotently(message: Envelope): Promise<void> {
    try { await this.inbox.enqueue(message); }
    catch (error) {
      if (errorCode(error) !== 'ALREADY_EXISTS') throw error;
    }
  }

  private state(receipt: Receipt | undefined, claimed: boolean): RequestRuntimeState {
    if (!receipt) return claimed ? 'delivered' : 'queued';
    if (receipt.status === 'delivered') return 'delivered';
    if (receipt.status === 'read') return 'accepted';
    if (receipt.status === 'replied') return 'replied';
    if (receipt.status === 'cancelled') return 'cancelled';
    if (receipt.status === 'expired') return 'expired';
    if (receipt.status === 'failed') return 'failed';
    return 'delivered';
  }

  async send(membership: Membership, input: {
    readonly to: string;
    readonly kind: Exclude<MessageKind, 'reply' | 'cancel'>;
    readonly body: string;
    readonly threadId?: string;
    readonly ttlMs?: number;
    readonly signal?: AbortSignal;
  }): Promise<Envelope> {
    await this.memberships.assertOwner(membership);
    if (!sendKinds.has(input.kind)) throw new Error('Invalid outbound message kind.');
    const peer = await this.memberships.resolveAlias(membership, input.to);
    input.signal?.throwIfAborted();
    if (peer.memberId === membership.memberId) throw new Error('Cannot send a message to yourself.');
    const ttlMs = input.ttlMs ?? MAX_MESSAGE_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_MESSAGE_TTL_MS) throw new Error('Invalid message TTL.');
    const messageId = randomUUID();
    const timestamp = this.now();
    const message: Envelope = {
      schemaVersion: 2,
      messageId,
      teamId: membership.teamId,
      threadId: input.threadId ?? messageId,
      ...(input.kind === 'request' ? { requestId: messageId } : {}),
      kind: input.kind,
      fromMemberId: membership.memberId,
      toMemberId: peer.memberId,
      senderGeneration: membership.memberGeneration,
      ...(peer.status === 'online' ? { recipientGeneration: peer.generation } : {}),
      createdAt: new Date(timestamp).toISOString(),
      expiresAt: new Date(timestamp + ttlMs).toISOString(),
      body: input.body,
    };
    input.signal?.throwIfAborted();
    await this.inbox.enqueue(message);
    return message;
  }

  private async pageAll(load: (cursor?: string) => Promise<InboxPage>, cursor?: string): Promise<readonly Envelope[]> {
    const page = await load(cursor);
    return page.nextCursor
      ? [...page.messages, ...await this.pageAll(load, page.nextCursor)]
      : page.messages;
  }

  private async findRequest(teamId: string, requestId: string): Promise<{
    readonly message: Envelope;
    readonly location: 'pending' | 'claimed';
  } | undefined> {
    const members = await this.teams.listMembers(teamId);
    const matches = await Promise.all(members.map(async member => {
      const pending = await this.inbox.readPending(teamId, member.memberId, requestId);
      if (pending) return { message: pending, location: 'pending' as const };
      const claimed = await this.inbox.readClaimed(teamId, member.memberId, requestId);
      return claimed ? { message: claimed, location: 'claimed' as const } : undefined;
    }));
    return matches.find((match): match is NonNullable<typeof match> => match !== undefined);
  }

  async requestState(membership: Membership, requestId: string): Promise<RequestRuntimeState> {
    await this.memberships.assertOwner(membership);
    const found = await this.findRequest(membership.teamId, requestId);
    if (found && found.message.kind === 'request' && found.message.fromMemberId === membership.memberId) {
      const receipt = await this.receipts.read(membership.teamId, found.message.toMemberId, requestId);
      return this.state(receipt, found.location === 'claimed');
    }
    const members = await this.teams.listMembers(membership.teamId);
    const receipts = await Promise.all(members.map(member =>
      this.receipts.read(membership.teamId, member.memberId, requestId)));
    const terminal = receipts.find(receipt => receipt && ['replied', 'cancelled', 'expired', 'failed'].includes(receipt.status));
    if (terminal) return this.state(terminal, false);
    throw Object.assign(new Error(`Unknown outgoing request "${requestId}".`), { code: 'NOT_FOUND' });
  }

  async cancel(membership: Membership, requestId: string, body = 'The sender cancelled this request.'): Promise<boolean> {
    await this.memberships.assertOwner(membership);
    return withStorageLock(this.lockPath(membership.teamId, requestId), async () => {
      await this.memberships.assertOwner(membership);
      const found = await this.findRequest(membership.teamId, requestId);
      if (!found || found.message.kind !== 'request' || found.message.fromMemberId !== membership.memberId ||
          found.message.senderGeneration !== membership.memberGeneration) {
        throw Object.assign(new Error(`Unknown owned request "${requestId}".`), { code: 'NOT_FOUND' });
      }
      const current = await this.receipts.read(membership.teamId, found.message.toMemberId, requestId);
      const state = this.state(current, found.location === 'claimed');
      if (terminalRequestStates.has(state)) return false;
      await this.receipts.record({
        schemaVersion: 2,
        teamId: membership.teamId,
        messageId: requestId,
        recipientId: found.message.toMemberId,
        status: 'cancelled',
        at: new Date(this.now()).toISOString(),
      });
      const timestamp = this.now();
      const cancellation: Envelope = {
        schemaVersion: 2,
        messageId: `cancel-${requestId}`,
        teamId: membership.teamId,
        threadId: found.message.threadId,
        requestId,
        kind: 'cancel',
        fromMemberId: membership.memberId,
        toMemberId: found.message.toMemberId,
        senderGeneration: membership.memberGeneration,
        recipientGeneration: found.message.recipientGeneration,
        createdAt: new Date(timestamp).toISOString(),
        expiresAt: new Date(timestamp + MAX_MESSAGE_TTL_MS).toISOString(),
        body,
      };
      try {
        await this.enqueueIdempotently(cancellation);
        if (found.location === 'pending') {
          await this.inbox.removePending(membership.teamId, found.message.toMemberId, requestId);
        }
      } catch (error) {
        if (!['TEAM_CLOSED', 'QUOTA_EXCEEDED'].includes(errorCode(error) ?? '')) throw error;
      }
      return true;
    });
  }

  async isCancelled(membership: Membership, requestId: string): Promise<boolean> {
    await this.memberships.assertOwner(membership);
    const receipt = await this.receipts.read(membership.teamId, membership.memberId, requestId);
    return receipt?.status === 'cancelled';
  }

  async reply(membership: Membership, requestId: string, body: string, signal?: AbortSignal): Promise<ReplyResult> {
    await this.memberships.assertOwner(membership);
    return withStorageLock(this.lockPath(membership.teamId, requestId), () =>
      this.delivery.settle(membership, requestId, async original => {
        if (original.kind !== 'request' || original.requestId !== requestId) {
          throw Object.assign(new Error(`Unknown claimed request "${requestId}".`), { code: 'NOT_FOUND' });
        }
        const receipt = await this.receipts.read(membership.teamId, membership.memberId, requestId);
        if (receipt?.status === 'cancelled' || receipt?.status === 'expired' || receipt?.status === 'failed') {
          return { accepted: false, reason: receipt.status };
        }
        if (!receipt || !['delivered', 'read'].includes(receipt.status)) throw new Error('Read the claimed request before replying.');
        if (messageExpired(original, this.now())) {
          await this.receipts.record({ ...receipt, status: 'expired', at: new Date(this.now()).toISOString() });
          return { accepted: false, reason: 'expired' };
        }
        const sender = await this.teams.readMember(membership.teamId, original.fromMemberId);
        if (!sender || sender.state !== 'active' || sender.generation !== original.senderGeneration) {
          await this.receipts.record({ ...receipt, status: 'failed', at: new Date(this.now()).toISOString() });
          return { accepted: false, reason: 'sender-replaced' };
        }
        signal?.throwIfAborted();
        const timestamp = this.now();
        const reply: Envelope = {
          schemaVersion: 2,
          messageId: `reply-${requestId}`,
          teamId: membership.teamId,
          threadId: original.threadId,
          requestId,
          kind: 'reply',
          fromMemberId: membership.memberId,
          toMemberId: original.fromMemberId,
          senderGeneration: membership.memberGeneration,
          recipientGeneration: original.senderGeneration,
          createdAt: new Date(timestamp).toISOString(),
          expiresAt: new Date(timestamp + MAX_MESSAGE_TTL_MS).toISOString(),
          body,
        };
        try { await this.enqueueIdempotently(reply); }
        catch (error) {
          if (errorCode(error) !== 'FENCED') throw error;
          await this.receipts.record({ ...receipt, status: 'failed', at: new Date(this.now()).toISOString() });
          return { accepted: false, reason: 'sender-replaced' };
        }
        await this.receipts.record({ ...receipt, status: 'replied', at: new Date(this.now()).toISOString() });
        return { accepted: true, message: reply };
      }));
  }

  async receive(membership: Membership, messageId: string, signal?: AbortSignal): Promise<{ readonly message?: Envelope; readonly discarded: boolean }> {
    signal?.throwIfAborted();
    const pending = await this.inbox.readPending(membership.teamId, membership.memberId, messageId);
    if (pending) await this.delivery.claim(membership, messageId, signal);
    return this.read(membership, messageId, signal);
  }

  async read(membership: Membership, messageId: string, signal?: AbortSignal): Promise<{ readonly message?: Envelope; readonly discarded: boolean }> {
    const message = await this.delivery.read(membership, messageId, signal);
    if (message.kind === 'request') return { message, discarded: false };
    if (message.kind === 'reply' && message.requestId) {
      const original = await this.receipts.read(membership.teamId, message.fromMemberId, message.requestId);
      if (original && ['cancelled', 'expired', 'failed'].includes(original.status)) {
        await this.delivery.fail(membership, messageId);
        return { discarded: true };
      }
    }
    const receipt = await this.receipts.read(membership.teamId, membership.memberId, messageId);
    if (receipt && receipt.status === 'read') {
      await this.receipts.record({ ...receipt, status: 'replied', at: new Date(this.now()).toISOString() });
    }
    await this.delivery.finish(membership, messageId);
    return { message, discarded: false };
  }

  async cancelAbandoned(original: Envelope): Promise<boolean> {
    if (original.kind !== 'request' || original.requestId !== original.messageId) return false;
    return withStorageLock(this.lockPath(original.teamId, original.messageId), async () => {
      const receipt = await this.receipts.read(original.teamId, original.toMemberId, original.messageId);
      if (receipt && ['replied', 'cancelled', 'expired', 'failed'].includes(receipt.status)) return false;
      await this.receipts.record(receipt ? {
        ...receipt,
        status: 'cancelled',
        at: new Date(this.now()).toISOString(),
      } : {
        schemaVersion: 2,
        teamId: original.teamId,
        messageId: original.messageId,
        recipientId: original.toMemberId,
        status: 'cancelled',
        at: new Date(this.now()).toISOString(),
      });
      return true;
    });
  }

  async repairCancellation(original: Envelope, location: 'pending' | 'claimed'): Promise<boolean> {
    if (original.kind !== 'request' || original.requestId !== original.messageId) return false;
    return withStorageLock(this.lockPath(original.teamId, original.messageId), async () => {
      const receipt = await this.receipts.read(original.teamId, original.toMemberId, original.messageId);
      if (receipt?.status !== 'cancelled') return false;
      const timestamp = this.now();
      const cancellation: Envelope = {
        schemaVersion: 2,
        messageId: `cancel-${original.messageId}`,
        teamId: original.teamId,
        threadId: original.threadId,
        requestId: original.messageId,
        kind: 'cancel',
        fromMemberId: original.fromMemberId,
        toMemberId: original.toMemberId,
        senderGeneration: original.senderGeneration,
        recipientGeneration: original.recipientGeneration,
        createdAt: new Date(timestamp).toISOString(),
        expiresAt: new Date(timestamp + MAX_MESSAGE_TTL_MS).toISOString(),
        body: 'The sender cancelled this request.',
      };
      try {
        await this.enqueueIdempotently(cancellation);
        if (location === 'pending') {
          await this.inbox.removePending(original.teamId, original.toMemberId, original.messageId);
        }
        return true;
      } catch (error) {
        if (['TEAM_CLOSED', 'QUOTA_EXCEEDED', 'FENCED'].includes(errorCode(error) ?? '')) return false;
        throw error;
      }
    });
  }

  async repairReplyOutcome(reply: Envelope): Promise<boolean> {
    if (reply.kind !== 'reply' || !reply.requestId) return false;
    return withStorageLock(this.lockPath(reply.teamId, reply.requestId), async () => {
      const original = await this.inbox.readClaimed(reply.teamId, reply.fromMemberId, reply.requestId!);
      if (!original || original.kind !== 'request' || original.fromMemberId !== reply.toMemberId ||
          original.toMemberId !== reply.fromMemberId || original.threadId !== reply.threadId) return false;
      const receipt = await this.receipts.read(reply.teamId, reply.fromMemberId, reply.requestId!);
      if (!receipt || !['delivered', 'read'].includes(receipt.status)) return false;
      await this.receipts.record({ ...receipt, status: 'replied', at: new Date(this.now()).toISOString() });
      return true;
    });
  }

  async leave(membership: Membership): Promise<number> {
    const cancelled = await this.cancelOutgoing(membership);
    await this.memberships.leave(membership);
    return cancelled;
  }

  async cancelOutgoing(membership: Membership): Promise<number> {
    await this.memberships.assertOwner(membership);
    const members = await this.teams.listMembers(membership.teamId);
    const mail = (await Promise.all(members.map(async member => [
      ...await this.pageAll(cursor => this.inbox.listPending(membership.teamId, member.memberId, 100, cursor)),
      ...await this.pageAll(cursor => this.inbox.listClaimed(membership.teamId, member.memberId, 100, cursor)),
    ]))).flat();
    const requests = mail.filter(message => message.kind === 'request' && message.fromMemberId === membership.memberId &&
      message.senderGeneration === membership.memberGeneration && message.requestId === message.messageId);
    const outcomes = await Promise.allSettled(requests.map(request => this.cancel(membership, request.messageId)));
    const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    if (failures.length > 0) throw new AggregateError(failures.map(failure => failure.reason), 'Some outgoing requests could not be cancelled.');
    return outcomes.filter(outcome => outcome.status === 'fulfilled' && outcome.value).length;
  }
}
