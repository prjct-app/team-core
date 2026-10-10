import { createHash } from 'node:crypto';
import { leaseExpired, sameLeaseOwner, type Lease } from '../domain/lease.ts';
import type { Member } from '../domain/member.ts';
import { LeaseStore } from '../storage/lease-store.ts';
import { TeamStore } from '../storage/team-store.ts';

export const DEFAULT_PRESENCE_TTL_MS = 30_000;

export type PresenceOwner = {
  readonly teamId: string;
  readonly memberId: string;
  readonly memberGeneration: number;
  readonly leaseToken: string;
  readonly leaseGeneration: number;
};

export class PresenceService {
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly teams: TeamStore,
    private readonly leases: LeaseStore,
    options: { readonly ttlMs?: number; readonly now?: () => number } = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_PRESENCE_TTL_MS;
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) throw new Error('Invalid presence TTL.');
  }

  leaseId(memberId: string): string {
    return `presence-${createHash('sha256').update(memberId).digest('hex')}`;
  }
  holderId(memberId: string, generation: number): string {
    return `member-${createHash('sha256').update(`${memberId}:${generation}`).digest('hex')}`;
  }

  async acquire(teamId: string, memberId: string, memberGeneration: number): Promise<PresenceOwner> {
    const lease = await this.leases.acquire({
      teamId,
      leaseId: this.leaseId(memberId),
      kind: 'presence',
      holderId: this.holderId(memberId, memberGeneration),
      resourceId: memberId,
      ttlMs: this.ttlMs,
    });
    return {
      teamId,
      memberId,
      memberGeneration,
      leaseToken: lease.token,
      leaseGeneration: lease.generation,
    };
  }

  async assertOwner(owner: PresenceOwner): Promise<{ readonly member: Member; readonly lease: Lease }> {
    const [member, lease] = await Promise.all([
      this.teams.readMember(owner.teamId, owner.memberId),
      this.leases.read(owner.teamId, this.leaseId(owner.memberId)),
    ]);
    if (!member || member.state !== 'active' || member.generation !== owner.memberGeneration ||
        !lease || lease.kind !== 'presence' || lease.resourceId !== owner.memberId ||
        lease.holderId !== this.holderId(owner.memberId, owner.memberGeneration) ||
        !sameLeaseOwner(lease, owner.leaseToken, owner.leaseGeneration) || leaseExpired(lease, this.now())) {
      throw Object.assign(new Error('Membership ownership has been fenced.'), { code: 'FENCED' });
    }
    return { member, lease };
  }

  async renew(owner: PresenceOwner): Promise<Lease> {
    await this.assertOwner(owner);
    return this.leases.renew(
      owner.teamId,
      this.leaseId(owner.memberId),
      this.holderId(owner.memberId, owner.memberGeneration),
      owner.leaseToken,
      owner.leaseGeneration,
      this.ttlMs,
    );
  }

  /** The same owner while its lease holds; a new lease once it lapsed; fenced when someone else holds it. */
  async reclaim(owner: PresenceOwner): Promise<PresenceOwner> {
    const lease = await this.leases.read(owner.teamId, this.leaseId(owner.memberId));
    if (lease && !leaseExpired(lease, this.now())) {
      if (lease.holderId === this.holderId(owner.memberId, owner.memberGeneration) && sameLeaseOwner(lease, owner.leaseToken, owner.leaseGeneration)) return owner;
      throw Object.assign(new Error('Membership ownership has been fenced.'), { code: 'FENCED' });
    }
    return this.acquire(owner.teamId, owner.memberId, owner.memberGeneration);
  }

  async release(owner: PresenceOwner): Promise<void> {
    await this.leases.release(
      owner.teamId,
      this.leaseId(owner.memberId),
      this.holderId(owner.memberId, owner.memberGeneration),
      owner.leaseToken,
      owner.leaseGeneration,
    );
  }

  async online(member: Member): Promise<boolean> {
    if (member.state !== 'active') return false;
    const lease = await this.leases.read(member.teamId, this.leaseId(member.memberId));
    return !!lease && lease.kind === 'presence' && lease.resourceId === member.memberId &&
      lease.holderId === this.holderId(member.memberId, member.generation) && !leaseExpired(lease, this.now());
  }
}
