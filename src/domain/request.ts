import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { MAX_MESSAGE_TTL_MS } from './message.ts';
import { EntityIdSchema, TeamIdSchema, TimestampSchema, timestampMillis } from './team.ts';

export type RequestState = 'queued' | 'delivered' | 'accepted' | 'replied' | 'cancelled' | 'expired';

export type Request = {
  readonly schemaVersion: 2;
  readonly requestId: string;
  readonly messageId: string;
  readonly teamId: string;
  readonly senderMemberId: string;
  readonly recipientMemberId: string;
  readonly senderGeneration: number;
  readonly recipientGeneration?: number;
  readonly state: RequestState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
};

export const RequestSchema = Type.Object({
  schemaVersion: Type.Literal(2),
  requestId: EntityIdSchema,
  messageId: EntityIdSchema,
  teamId: TeamIdSchema,
  senderMemberId: EntityIdSchema,
  recipientMemberId: EntityIdSchema,
  senderGeneration: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  recipientGeneration: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  state: Type.Union([
    Type.Literal('queued'), Type.Literal('delivered'), Type.Literal('accepted'), Type.Literal('replied'),
    Type.Literal('cancelled'), Type.Literal('expired'),
  ]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  expiresAt: TimestampSchema,
}, { additionalProperties: false });

const transitions: Readonly<Record<RequestState, readonly RequestState[]>> = {
  queued: ['delivered', 'cancelled', 'expired'],
  delivered: ['accepted', 'cancelled', 'expired'],
  accepted: ['replied', 'cancelled', 'expired'],
  replied: [],
  cancelled: [],
  expired: [],
};

export function assertRequest(value: unknown): asserts value is Request {
  if (!Value.Check(RequestSchema, value)) throw new Error('Invalid Team v2 request record.');
  const request = value as Request;
  const created = timestampMillis(request.createdAt, 'request createdAt');
  const updated = timestampMillis(request.updatedAt, 'request updatedAt');
  const expires = timestampMillis(request.expiresAt, 'request expiresAt');
  if (updated < created || expires <= created || expires - created > MAX_MESSAGE_TTL_MS) {
    throw new Error('Invalid request timestamp ordering or TTL.');
  }
}

export function assertRequestTransition(from: RequestState, to: RequestState): void {
  if (!transitions[from].includes(to)) throw new Error(`Invalid request transition: ${from} → ${to}.`);
}

export function requestTerminal(state: RequestState): boolean {
  return transitions[state].length === 0;
}
