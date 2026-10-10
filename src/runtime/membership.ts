import { randomUUID } from 'node:crypto';
import type { Member, MemberKind } from '../domain/member.ts';
import { assertEntityId, assertTeamId } from '../domain/team.ts';
import { withStorageLock } from '../storage/atomic.ts';
import { TeamPaths } from '../storage/paths.ts';
import { TeamStore } from '../storage/team-store.ts';
import { PresenceService, type PresenceOwner } from './presence.ts';

export type Membership = PresenceOwner & {
  readonly alias: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly kind: MemberKind;
};

export type PeerStatus = {
  readonly memberId: string;
  readonly alias: string;
  readonly kind: MemberKind;
  readonly generation: number;
  readonly status: 'online' | 'offline';
};

export type PeerPage = {
  readonly peers: readonly PeerStatus[];
  readonly nextCursor?: string;
};

function positiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`Invalid ${label} in supervised Team environment.`);
  return parsed;
}

export function workerMembershipFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Membership | undefined {
  const names = [
    'PI_TEAM_TEAM_ID', 'PI_TEAM_MEMBER_ID', 'PI_TEAM_MEMBER_ALIAS', 'PI_TEAM_MEMBER_SESSION',
    'PI_TEAM_MEMBER_GENERATION', 'PI_TEAM_MEMBER_LEASE_TOKEN', 'PI_TEAM_MEMBER_LEASE_GENERATION',
  ] as const;
  const present = names.filter(name => environment[name] !== undefined);
  if (present.length === 0) return undefined;
  if (present.length !== names.length) throw new Error('Incomplete supervised Team membership environment.');
  const teamId = assertTeamId(environment.PI_TEAM_TEAM_ID!);
  const memberId = assertEntityId(environment.PI_TEAM_MEMBER_ID!, 'member ID');
  const alias = assertTeamId(environment.PI_TEAM_MEMBER_ALIAS!);
  const sessionId = assertEntityId(environment.PI_TEAM_MEMBER_SESSION!, 'session ID');
  const leaseToken = environment.PI_TEAM_MEMBER_LEASE_TOKEN!;
  // Same shape the lease store issues and the lease schema accepts (a UUID
  // today). Requiring 64 hex characters rejected every real Expert at startup.
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(leaseToken)) throw new Error('Invalid supervised Team membership environment.');
  return {
    teamId,
    memberId,
    memberGeneration: positiveInteger(environment.PI_TEAM_MEMBER_GENERATION, 'member generation'),
    leaseToken,
    leaseGeneration: positiveInteger(environment.PI_TEAM_MEMBER_LEASE_GENERATION, 'lease generation'),
    alias,
    sessionId,
    cwd,
    kind: 'supervised',
  };
}

export class MembershipService {
  constructor(
    private readonly paths: TeamPaths,
    private readonly teams: TeamStore,
    private readonly presence: PresenceService,
    private readonly now: () => number = Date.now,
  ) {}

  private lockPath(teamId: string): string { return this.paths.lock(`membership-${assertTeamId(teamId)}`); }

  private membership(member: Member, owner: PresenceOwner): Membership {
    if (!member.sessionId) throw new Error('Joined member is missing its session identity.');
    return {
      ...owner,
      alias: member.alias,
      sessionId: member.sessionId,
      cwd: member.cwd,
      kind: member.kind,
    };
  }

  async join(input: {
    readonly teamId: string;
    readonly alias: string;
    readonly sessionId: string;
    readonly cwd: string;
    readonly kind: MemberKind;
    /** Rejoin this exact member (its address survives renames); otherwise matched by alias. */
    readonly memberId?: string;
    /** An active member belongs to the session that holds it, online or not; only it may rejoin. */
    readonly boundToSession?: boolean;
    /** Take over an active member from another session: a fork carrying the role forward. */
    readonly adopt?: boolean;
  }): Promise<Membership> {
    return withStorageLock(this.lockPath(input.teamId), async () => {
      const team = await this.teams.read(input.teamId);
      if (!team) throw Object.assign(new Error(`Unknown team "${input.teamId}".`), { code: 'NOT_FOUND' });
      if (team.state !== 'open') throw Object.assign(new Error(`Team "${input.teamId}" is ${team.state}.`), { code: 'TEAM_CLOSED' });
      const members = await this.teams.listMembers(input.teamId);
      const byId = input.memberId ? members.filter(member => member.memberId === input.memberId) : [];
      const matching = byId.length ? byId : members.filter(member => member.alias === input.alias);
      const active = matching.find(member => member.state === 'active');
      if (input.boundToSession && !input.adopt && active && active.sessionId !== input.sessionId) {
        throw Object.assign(new Error(`Alias "${active.alias}" belongs to another session.`), { code: 'OWNED', cwd: active.cwd });
      }
      if (active && await this.presence.online(active)) {
        throw Object.assign(new Error(`Alias "${active.alias}" is already active.`), { code: 'ALREADY_EXISTS' });
      }
      const previous = active ?? [...matching].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      const memberId = previous?.memberId ?? randomUUID();
      const generation = (previous?.generation ?? 0) + 1;
      const owner = await this.presence.acquire(input.teamId, memberId, generation);
      const timestamp = new Date(this.now()).toISOString();
      try {
        if (!previous) {
          const member: Member = {
            schemaVersion: 2,
            teamId: input.teamId,
            memberId,
            sessionId: input.sessionId,
            alias: input.alias,
            kind: input.kind,
            generation,
            state: 'active',
            cwd: input.cwd,
            joinedAt: timestamp,
            updatedAt: timestamp,
          };
          await this.teams.createMember(member);
          return this.membership(member, owner);
        }
        const member = await this.teams.updateMember(input.teamId, memberId, previous.generation, current => {
          const { leftAt: _leftAt, ...retained } = current;
          return {
            ...retained,
            sessionId: input.sessionId,
            alias: input.alias,
            kind: input.kind,
            generation,
            state: 'active',
            cwd: input.cwd,
            updatedAt: timestamp,
          };
        });
        return this.membership(member, owner);
      } catch (error) {
        await this.presence.release(owner).catch(() => {});
        throw error;
      }
    });
  }

  async assertOwner(membership: Membership): Promise<Member> {
    const { member } = await this.presence.assertOwner(membership);
    // Identity is the member ID, generation, lease and session. The alias is a
    // display label that may be renamed while the member is online.
    if (member.sessionId !== membership.sessionId) {
      throw Object.assign(new Error('Membership identity has been replaced.'), { code: 'FENCED' });
    }
    return member;
  }

  async heartbeat(membership: Membership): Promise<void> {
    await withStorageLock(this.lockPath(membership.teamId), async () => {
      await this.assertOwner(membership);
      await this.presence.renew(membership);
    });
  }

  /**
   * After a failed heartbeat (the machine slept, the disk stalled): keeps the
   * membership while its member record is still this one, taking back a lease
   * that lapsed. Fenced once the member moved on (removed, or another terminal
   * joined under it); NOT_FOUND once the team is gone.
   */
  async reclaim(membership: Membership): Promise<Membership> {
    return withStorageLock(this.lockPath(membership.teamId), async () => {
      if (!await this.teams.read(membership.teamId)) throw Object.assign(new Error(`Unknown team "${membership.teamId}".`), { code: 'NOT_FOUND' });
      const member = await this.teams.readMember(membership.teamId, membership.memberId);
      if (!member || member.state !== 'active' || member.generation !== membership.memberGeneration || member.sessionId !== membership.sessionId) {
        throw Object.assign(new Error('Membership identity has been replaced.'), { code: 'FENCED' });
      }
      return { ...membership, ...await this.presence.reclaim(membership) };
    });
  }

  /** Goes offline and keeps the member: the same session takes it back on its next start. */
  async disconnect(membership: Membership): Promise<void> {
    await withStorageLock(this.lockPath(membership.teamId), async () => {
      await this.assertOwner(membership);
      await this.presence.release(membership).catch(() => {});
    });
  }

  async leave(membership: Membership): Promise<void> {
    await withStorageLock(this.lockPath(membership.teamId), async () => {
      const member = await this.assertOwner(membership);
      const timestamp = new Date(this.now()).toISOString();
      await this.teams.updateMember(member.teamId, member.memberId, member.generation, current => ({
        ...current,
        state: 'left',
        leftAt: timestamp,
        updatedAt: timestamp,
      }));
      await this.presence.release(membership).catch(() => {});
    });
  }

  async peers(membership: Membership): Promise<readonly PeerStatus[]> {
    await this.assertOwner(membership);
    const members = await this.teams.listMembers(membership.teamId);
    const latest = [...members]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .filter((member, index, all) => all.findIndex(candidate => candidate.alias === member.alias) === index);
    return Promise.all(latest.map(async member => ({
      memberId: member.memberId,
      alias: member.alias,
      kind: member.kind,
      generation: member.generation,
      status: await this.presence.online(member) ? 'online' as const : 'offline' as const,
    })));
  }

  async member(teamId: string, memberId: string): Promise<Member | undefined> {
    return this.teams.readMember(teamId, memberId);
  }

  async peerPage(membership: Membership, limit = 50, cursor?: string): Promise<PeerPage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Peer page limit must be between 1 and 100.');
    const peers = [...await this.peers(membership)]
      .filter(peer => peer.memberId !== membership.memberId)
      .sort((a, b) => a.memberId.localeCompare(b.memberId));
    const remaining = cursor === undefined ? peers : peers.filter(peer => peer.memberId > cursor);
    const page = remaining.slice(0, limit);
    const nextCursor = remaining.length > limit ? page.at(-1)?.memberId : undefined;
    return { peers: page, ...(nextCursor ? { nextCursor } : {}) };
  }

  async resolveAlias(membership: Membership, alias: string): Promise<PeerStatus> {
    const peer = (await this.peers(membership)).find(candidate => candidate.alias === alias);
    if (!peer) throw Object.assign(new Error(`Unknown teammate "${alias}".`), { code: 'NOT_FOUND' });
    return peer;
  }
}
