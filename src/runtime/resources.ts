import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { leaseExpired, sameLeaseOwner, type Lease } from '../domain/lease.ts';
import { MAX_MESSAGE_TTL_MS } from '../domain/message.ts';
import { LeaseStore } from '../storage/lease-store.ts';
import { MembershipService, type Membership } from './membership.ts';

export const DEFAULT_RESOURCE_LEASE_MS = 5 * 60_000;

export class ResourceLeaseService {
  private readonly now: () => number;

  constructor(
    private readonly memberships: MembershipService,
    private readonly leases: LeaseStore,
    now: () => number = Date.now,
  ) {
    this.now = now;
  }

  leaseId(resourceId: string): string {
    this.assertResource(resourceId);
    return `resource-${createHash('sha256').update(resourceId).digest('hex')}`;
  }

  holderId(membership: Membership): string {
    return `member-${createHash('sha256').update(`${membership.memberId}:${membership.memberGeneration}`).digest('hex')}`;
  }

  private assertResource(resourceId: string): void {
    if (resourceId.length === 0 || Buffer.byteLength(resourceId, 'utf8') > 4096 || /[\0-\x1f\x7f]/u.test(resourceId)) {
      throw new Error('Resource ID must be 1 to 4096 UTF-8 bytes without control characters.');
    }
  }

  private canonicalResource(membership: Membership, resourceId: string): string {
    this.assertResource(resourceId);
    const canonical = resolve(membership.cwd, resourceId);
    if (Buffer.byteLength(canonical, 'utf8') > 4096) throw new Error('Canonical resource path exceeds 4096 UTF-8 bytes.');
    return canonical;
  }

  private async current(
    membership: Membership,
    resourceId: string,
    token: string,
    generation: number,
  ): Promise<Lease> {
    await this.memberships.assertOwner(membership);
    const lease = await this.leases.read(membership.teamId, this.leaseId(resourceId));
    if (!lease || lease.kind !== 'resource' || lease.resourceId !== resourceId ||
        lease.holderId !== this.holderId(membership) || !sameLeaseOwner(lease, token, generation) ||
        leaseExpired(lease, this.now())) {
      throw Object.assign(new Error('Resource lease ownership has been fenced.'), { code: 'FENCED' });
    }
    return lease;
  }

  async claim(
    membership: Membership,
    resourceId: string,
    ttlMs = DEFAULT_RESOURCE_LEASE_MS,
    signal?: AbortSignal,
  ): Promise<Lease> {
    await this.memberships.assertOwner(membership);
    signal?.throwIfAborted();
    const canonical = this.canonicalResource(membership, resourceId);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_MESSAGE_TTL_MS) throw new Error('Invalid resource lease TTL.');
    signal?.throwIfAborted();
    return this.leases.acquire({
      teamId: membership.teamId,
      leaseId: this.leaseId(canonical),
      kind: 'resource',
      holderId: this.holderId(membership),
      resourceId: canonical,
      ttlMs,
    });
  }

  async renew(
    membership: Membership,
    resourceId: string,
    token: string,
    generation: number,
    ttlMs = DEFAULT_RESOURCE_LEASE_MS,
  ): Promise<Lease> {
    const canonical = this.canonicalResource(membership, resourceId);
    const lease = await this.current(membership, canonical, token, generation);
    return this.leases.renew(
      membership.teamId,
      lease.leaseId,
      this.holderId(membership),
      lease.token,
      lease.generation,
      ttlMs,
    );
  }

  async release(
    membership: Membership,
    resourceId: string,
    token: string,
    generation: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const canonical = this.canonicalResource(membership, resourceId);
    const lease = await this.current(membership, canonical, token, generation);
    signal?.throwIfAborted();
    await this.leases.release(
      membership.teamId,
      lease.leaseId,
      this.holderId(membership),
      lease.token,
      lease.generation,
    );
  }
}
