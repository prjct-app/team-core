import { randomUUID } from 'node:crypto';
import { assertLease, leaseExpired, sameLeaseOwner, type Lease, type LeaseKind } from '../domain/lease.ts';
import { assertEntityId, assertTeam, assertTeamId, type Team } from '../domain/team.ts';
import {
  createAtomicJson, ensurePrivateDirectory, ensurePrivateTree, jsonFileNames, readJson, replaceAtomicJson, withStorageLock,
} from './atomic.ts';
import { TeamPaths } from './paths.ts';

const LEASE_MAX_BYTES = 16 * 1024;
const TEAM_MAX_BYTES = 32 * 1024;
const DEFAULT_MAX_TTL_MS = 24 * 60 * 60 * 1000;

export type AcquireLease = {
  readonly teamId: string;
  readonly leaseId: string;
  readonly kind: LeaseKind;
  readonly holderId: string;
  readonly resourceId: string;
  readonly ttlMs: number;
};

export type LeaseStoreOptions = {
  readonly maxTtlMs?: number;
  readonly now?: () => number;
};

export class LeaseStore {
  private readonly maxTtlMs: number;
  private readonly now: () => number;

  constructor(readonly paths: TeamPaths, options: LeaseStoreOptions = {}) {
    this.maxTtlMs = options.maxTtlMs ?? DEFAULT_MAX_TTL_MS;
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(this.maxTtlMs) || this.maxTtlMs <= 0) throw new Error('Invalid maximum lease TTL.');
  }

  private lockPath(teamId: string): string { return this.paths.lock(`leases-${assertTeamId(teamId)}`); }

  private async prepare(): Promise<void> {
    await ensurePrivateTree(this.paths.root, 'teams');
    await ensurePrivateTree(this.paths.root, 'control');
  }

  private validateInput(input: AcquireLease): void {
    assertTeamId(input.teamId);
    assertEntityId(input.leaseId, 'lease ID');
    assertEntityId(input.holderId, 'lease holder ID');
    if (!['presence', 'delivery', 'resource'].includes(input.kind)) throw new Error('Invalid lease kind.');
    if (!input.resourceId || input.resourceId.length > 4096 || input.resourceId.includes('\0')) throw new Error('Invalid lease resource ID.');
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > this.maxTtlMs) throw new Error('Invalid lease TTL.');
  }

  private async requireTeam(teamId: string): Promise<Team> {
    try {
      await ensurePrivateDirectory(this.paths.team(teamId), false);
      await ensurePrivateDirectory(this.paths.leases(teamId), false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw Object.assign(new Error(`Unknown team "${teamId}".`), { code: 'NOT_FOUND' });
      }
      throw error;
    }
    const team = await readJson(this.paths.teamRecord(teamId), assertTeam, TEAM_MAX_BYTES);
    if (!team) throw Object.assign(new Error(`Team "${teamId}" is incomplete.`), { code: 'NOT_FOUND' });
    return team;
  }

  async read(teamId: string, leaseId: string): Promise<Lease | undefined> {
    await this.prepare();
    await this.requireTeam(teamId);
    const lease = await readJson(this.paths.lease(teamId, leaseId), assertLease, LEASE_MAX_BYTES);
    if (lease && (lease.teamId !== teamId || lease.leaseId !== leaseId)) {
      throw Object.assign(new Error('Lease identity does not match its storage path.'), { code: 'CORRUPT_RECORD' });
    }
    return lease;
  }

  async acquire(input: AcquireLease): Promise<Lease> {
    this.validateInput(input);
    await this.prepare();
    return withStorageLock(this.lockPath(input.teamId), async () => {
      const team = await this.requireTeam(input.teamId);
      if (team.state !== 'open') throw Object.assign(new Error(`Team "${input.teamId}" is ${team.state}.`), { code: 'TEAM_CLOSED' });
      const current = await this.read(input.teamId, input.leaseId);
      const now = this.now();
      if (current && !leaseExpired(current, now)) {
        throw Object.assign(new Error(`Lease "${input.leaseId}" is held.`), { code: 'LEASE_HELD' });
      }
      const lease: Lease = {
        schemaVersion: 2,
        teamId: input.teamId,
        leaseId: input.leaseId,
        kind: input.kind,
        holderId: input.holderId,
        resourceId: input.resourceId,
        token: randomUUID(),
        generation: (current?.generation ?? 0) + 1,
        acquiredAt: new Date(now).toISOString(),
        expiresAt: new Date(now + input.ttlMs).toISOString(),
      };
      assertLease(lease);
      if (current) await replaceAtomicJson(this.paths.lease(input.teamId, input.leaseId), lease, { maxBytes: LEASE_MAX_BYTES });
      else await createAtomicJson(this.paths.lease(input.teamId, input.leaseId), lease, LEASE_MAX_BYTES);
      return lease;
    });
  }

  async renew(
    teamId: string,
    leaseId: string,
    holderId: string,
    token: string,
    generation: number,
    ttlMs: number,
  ): Promise<Lease> {
    assertEntityId(holderId, 'lease holder ID');
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > this.maxTtlMs) throw new Error('Invalid lease TTL.');
    await this.prepare();
    return withStorageLock(this.lockPath(teamId), async () => {
      await this.requireTeam(teamId);
      const current = await this.read(teamId, leaseId);
      if (!current || current.holderId !== holderId || !sameLeaseOwner(current, token, generation)) {
        throw Object.assign(new Error('Lease ownership has been fenced.'), { code: 'FENCED' });
      }
      const now = this.now();
      if (leaseExpired(current, now)) throw Object.assign(new Error('Lease has expired.'), { code: 'EXPIRED' });
      const renewed = { ...current, expiresAt: new Date(now + ttlMs).toISOString() } satisfies Lease;
      assertLease(renewed);
      await replaceAtomicJson(this.paths.lease(teamId, leaseId), renewed, { maxBytes: LEASE_MAX_BYTES });
      return renewed;
    });
  }

  async release(teamId: string, leaseId: string, holderId: string, token: string, generation: number): Promise<void> {
    assertEntityId(holderId, 'lease holder ID');
    await this.prepare();
    await withStorageLock(this.lockPath(teamId), async () => {
      await this.requireTeam(teamId);
      const current = await this.read(teamId, leaseId);
      if (!current || current.holderId !== holderId || !sameLeaseOwner(current, token, generation)) {
        throw Object.assign(new Error('Lease ownership has been fenced.'), { code: 'FENCED' });
      }
      const releasedAt = Math.max(this.now(), Date.parse(current.acquiredAt));
      const released = { ...current, releasedAt: new Date(releasedAt).toISOString() } satisfies Lease;
      assertLease(released);
      await replaceAtomicJson(this.paths.lease(teamId, leaseId), released, { maxBytes: LEASE_MAX_BYTES });
    });
  }

  async list(teamId: string): Promise<readonly Lease[]> {
    assertTeamId(teamId);
    await this.prepare();
    await this.requireTeam(teamId);
    const ids = await jsonFileNames(this.paths.leases(teamId), false);
    const leases = await Promise.all(ids.map(id => this.read(teamId, id)));
    return leases.filter((lease): lease is Lease => lease !== undefined);
  }
}
