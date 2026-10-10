import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { EntityIdSchema, TeamIdSchema, TimestampSchema, timestampMillis } from './team.ts';

export type LeaseKind = 'presence' | 'delivery' | 'resource';

export type Lease = {
  readonly schemaVersion: 2;
  readonly leaseId: string;
  readonly teamId: string;
  readonly kind: LeaseKind;
  readonly holderId: string;
  readonly resourceId: string;
  readonly token: string;
  readonly generation: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly releasedAt?: string;
};

export const LeaseSchema = Type.Object({
  schemaVersion: Type.Literal(2),
  leaseId: EntityIdSchema,
  teamId: TeamIdSchema,
  kind: Type.Union([Type.Literal('presence'), Type.Literal('delivery'), Type.Literal('resource')]),
  holderId: EntityIdSchema,
  resourceId: Type.String({ minLength: 1, maxLength: 4096 }),
  token: Type.String({ minLength: 32, maxLength: 256 }),
  generation: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  acquiredAt: TimestampSchema,
  expiresAt: TimestampSchema,
  releasedAt: Type.Optional(TimestampSchema),
}, { additionalProperties: false });

export function assertLease(value: unknown): asserts value is Lease {
  if (!Value.Check(LeaseSchema, value)) throw new Error('Invalid Team v2 lease record.');
  const lease = value as Lease;
  if (lease.resourceId.includes('\0')) throw new Error('Lease resource ID contains a null byte.');
  const acquired = timestampMillis(lease.acquiredAt, 'lease acquiredAt');
  if (timestampMillis(lease.expiresAt, 'lease expiresAt') <= acquired) {
    throw new Error('Lease expiry must be after acquisition.');
  }
  if (lease.releasedAt !== undefined && timestampMillis(lease.releasedAt, 'lease releasedAt') < acquired) {
    throw new Error('Lease release precedes acquisition.');
  }
}

export function leaseExpired(lease: Lease, now = Date.now()): boolean {
  return lease.releasedAt !== undefined || timestampMillis(lease.expiresAt, 'lease expiresAt') <= now;
}

export function sameLeaseOwner(lease: Lease, token: string, generation: number): boolean {
  return lease.token === token && lease.generation === generation;
}
