import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { assertMember, memberBelongsToTeam, type Member } from '../domain/member.ts';
import { assertTeam, assertTeamId, assertTeamTransition, type Team } from '../domain/team.ts';
import {
  createAtomicJson, ensurePrivateDirectory, ensurePrivateTree, jsonFileNames, moveAtomic, readJson,
  replaceAtomicJson, withStorageLock,
} from './atomic.ts';
import { TeamPaths } from './paths.ts';

const TEAM_MAX_BYTES = 32 * 1024;
const MEMBER_MAX_BYTES = 64 * 1024;

export type TeamStoreOptions = {
  readonly maxMembers?: number;
};

export class TeamStore {
  readonly paths: TeamPaths;
  private readonly maxMembers: number;

  constructor(paths: TeamPaths, options: TeamStoreOptions = {}) {
    this.paths = paths;
    this.maxMembers = options.maxMembers ?? 100;
    if (!Number.isSafeInteger(this.maxMembers) || this.maxMembers < 1) throw new Error('Invalid member quota.');
  }

  private async prepare(): Promise<void> {
    await ensurePrivateTree(this.paths.root, 'teams');
    await ensurePrivateTree(this.paths.root, 'control');
  }

  private async requireTeamDirectory(teamId: string): Promise<void> {
    try {
      await ensurePrivateDirectory(this.paths.team(teamId), false);
      await ensurePrivateDirectory(this.paths.members(teamId), false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw Object.assign(new Error(`Unknown team "${teamId}".`), { code: 'NOT_FOUND' });
      }
      throw error;
    }
  }

  async create(team: Team): Promise<void> {
    assertTeam(team);
    await this.prepare();
    await withStorageLock(this.paths.teamLock(team.teamId), async () => {
      const target = this.paths.team(team.teamId);
      const existing = await lstat(target).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (existing) throw Object.assign(new Error(`Team "${team.teamId}" already exists.`), { code: 'ALREADY_EXISTS' });
      const temporary = join(this.paths.teams(), `.${team.teamId}.${randomUUID()}.tmp`);
      await mkdir(temporary, { mode: 0o700 });
      try {
        await Promise.all(['members', 'runtimes', 'inbox', 'receipts', 'leases'].map(
          name => ensurePrivateDirectory(join(temporary, name)),
        ));
        await createAtomicJson(join(temporary, 'team.json'), team, TEAM_MAX_BYTES);
        await moveAtomic(temporary, target);
      } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async list(): Promise<string[]> {
    await this.prepare();
    const entries = await readdir(this.paths.teams(), { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
      .map(entry => entry.name)
      .filter(name => {
        try { assertTeamId(name); return true; }
        catch { return false; }
      })
      .sort();
  }

  async read(teamId: string): Promise<Team | undefined> {
    assertTeamId(teamId);
    await this.prepare();
    try { await this.requireTeamDirectory(teamId); }
    catch (error) {
      if ((error as { code?: string }).code === 'NOT_FOUND') return undefined;
      throw error;
    }
    const team = await readJson(this.paths.teamRecord(teamId), assertTeam, TEAM_MAX_BYTES);
    if (team && team.teamId !== teamId) throw Object.assign(new Error('Team ID does not match its storage path.'), { code: 'CORRUPT_RECORD' });
    return team;
  }

  async update(teamId: string, change: (team: Team) => Team): Promise<Team> {
    assertTeamId(teamId);
    await this.prepare();
    return withStorageLock(this.paths.teamLock(teamId), async () => {
      await this.requireTeamDirectory(teamId);
      const current = await readJson(this.paths.teamRecord(teamId), assertTeam, TEAM_MAX_BYTES);
      if (!current) throw Object.assign(new Error(`Team "${teamId}" is incomplete or missing.`), { code: 'NOT_FOUND' });
      const next = change(current);
      assertTeam(next);
      if (next.teamId !== current.teamId || next.createdAt !== current.createdAt) {
        throw new Error('Team identity and creation timestamp are immutable.');
      }
      if (Date.parse(next.updatedAt) < Date.parse(current.updatedAt)) throw new Error('Team updatedAt moved backwards.');
      assertTeamTransition(current.state, next.state);
      await replaceAtomicJson(this.paths.teamRecord(teamId), next, { maxBytes: TEAM_MAX_BYTES, previous: true });
      return next;
    });
  }

  async createMember(member: Member): Promise<void> {
    assertMember(member);
    await this.prepare();
    await withStorageLock(this.paths.teamLock(member.teamId), async () => {
      await this.requireTeamDirectory(member.teamId);
      const team = await readJson(this.paths.teamRecord(member.teamId), assertTeam, TEAM_MAX_BYTES);
      if (!team) throw Object.assign(new Error(`Unknown team "${member.teamId}".`), { code: 'NOT_FOUND' });
      if (team.state !== 'open') throw Object.assign(new Error(`Team "${member.teamId}" is ${team.state}.`), { code: 'TEAM_CLOSED' });
      memberBelongsToTeam(member, team);
      await ensurePrivateDirectory(this.paths.members(member.teamId));
      const ids = await jsonFileNames(this.paths.members(member.teamId));
      if (ids.length >= this.maxMembers) throw Object.assign(new Error(`Team member quota reached (${this.maxMembers}).`), { code: 'QUOTA_EXCEEDED' });
      const members = await Promise.all(ids.map(id => readJson(this.paths.member(member.teamId, id), assertMember, MEMBER_MAX_BYTES)));
      if (members.some(existing => existing?.alias === member.alias && existing.state === 'active')) {
        throw Object.assign(new Error(`Member alias "${member.alias}" is already active.`), { code: 'ALREADY_EXISTS' });
      }
      await createAtomicJson(this.paths.member(member.teamId, member.memberId), member, MEMBER_MAX_BYTES);
    });
  }

  async readMember(teamId: string, memberId: string): Promise<Member | undefined> {
    await this.prepare();
    try { await this.requireTeamDirectory(teamId); }
    catch (error) {
      if ((error as { code?: string }).code === 'NOT_FOUND') return undefined;
      throw error;
    }
    const member = await readJson(this.paths.member(teamId, memberId), assertMember, MEMBER_MAX_BYTES);
    if (member && (member.teamId !== teamId || member.memberId !== memberId)) {
      throw Object.assign(new Error('Member identity does not match its storage path.'), { code: 'CORRUPT_RECORD' });
    }
    return member;
  }

  async listMembers(teamId: string): Promise<Member[]> {
    assertTeamId(teamId);
    await this.prepare();
    await this.requireTeamDirectory(teamId);
    const ids = await jsonFileNames(this.paths.members(teamId));
    const members = await Promise.all(ids.map(id => this.readMember(teamId, id)));
    return members.filter((member): member is Member => member !== undefined);
  }

  async updateMember(
    teamId: string,
    memberId: string,
    expectedGeneration: number,
    change: (member: Member) => Member,
  ): Promise<Member> {
    await this.prepare();
    return withStorageLock(this.paths.teamLock(teamId), async () => {
      await this.requireTeamDirectory(teamId);
      const current = await this.readMember(teamId, memberId);
      if (!current) throw Object.assign(new Error(`Unknown member "${memberId}".`), { code: 'NOT_FOUND' });
      if (current.generation !== expectedGeneration) {
        throw Object.assign(new Error('Member generation has changed.'), { code: 'FENCED' });
      }
      const next = change(current);
      assertMember(next);
      if (next.teamId !== current.teamId || next.memberId !== current.memberId || next.joinedAt !== current.joinedAt ||
          next.generation < current.generation || next.generation > current.generation + 1) {
        throw new Error('Invalid member identity or generation update.');
      }
      if (Date.parse(next.updatedAt) < Date.parse(current.updatedAt)) throw new Error('Member updatedAt moved backwards.');
      if (next.state === 'active' && (next.alias !== current.alias || current.state !== 'active')) {
        const members = await this.listMembers(teamId);
        if (members.some(member => member.memberId !== memberId && member.alias === next.alias && member.state === 'active')) {
          throw Object.assign(new Error(`Member alias "${next.alias}" is already active.`), { code: 'ALREADY_EXISTS' });
        }
      }
      await replaceAtomicJson(this.paths.member(teamId, memberId), next, { maxBytes: MEMBER_MAX_BYTES, previous: true });
      return next;
    });
  }
}
