import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { EntityIdSchema, TeamIdSchema, TimestampSchema, timestampMillis } from './team.ts';

/** A bound for the message store, not a writing budget for the model. */
export const MAX_MESSAGE_BODY_BYTES = 32 * 1024;
export const MAX_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;

export type MessageKind = 'info' | 'question' | 'proposal' | 'handoff' | 'blocker' | 'request' | 'reply' | 'cancel';
export type ReceiptStatus = 'delivered' | 'read' | 'replied' | 'cancelled' | 'expired' | 'failed';

export type Receipt = {
  readonly schemaVersion: 2;
  readonly teamId: string;
  readonly messageId: string;
  readonly recipientId: string;
  readonly status: ReceiptStatus;
  readonly at: string;
};

export const ReceiptSchema = Type.Object({
  schemaVersion: Type.Literal(2),
  teamId: TeamIdSchema,
  messageId: EntityIdSchema,
  recipientId: EntityIdSchema,
  status: Type.Union([
    Type.Literal('delivered'), Type.Literal('read'), Type.Literal('replied'), Type.Literal('cancelled'),
    Type.Literal('expired'), Type.Literal('failed'),
  ]),
  at: TimestampSchema,
}, { additionalProperties: false });

export function assertReceipt(value: unknown): asserts value is Receipt {
  if (!Value.Check(ReceiptSchema, value)) throw new Error('Invalid Team v2 receipt record.');
  timestampMillis((value as Receipt).at, 'receipt timestamp');
}

export type Envelope = {
  readonly schemaVersion: 2;
  readonly messageId: string;
  readonly teamId: string;
  readonly threadId: string;
  readonly requestId?: string;
  readonly kind: MessageKind;
  readonly fromMemberId: string;
  readonly toMemberId: string;
  readonly senderGeneration: number;
  readonly recipientGeneration?: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly body: string;
};

export const EnvelopeSchema = Type.Object({
  schemaVersion: Type.Literal(2),
  messageId: EntityIdSchema,
  teamId: TeamIdSchema,
  threadId: EntityIdSchema,
  requestId: Type.Optional(EntityIdSchema),
  kind: Type.Union([
    Type.Literal('info'), Type.Literal('question'), Type.Literal('proposal'), Type.Literal('handoff'),
    Type.Literal('blocker'), Type.Literal('request'), Type.Literal('reply'), Type.Literal('cancel'),
  ]),
  fromMemberId: EntityIdSchema,
  toMemberId: EntityIdSchema,
  senderGeneration: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  recipientGeneration: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
  body: Type.String({ maxLength: MAX_MESSAGE_BODY_BYTES }),
}, { additionalProperties: false });

export function assertEnvelope(value: unknown): asserts value is Envelope {
  if (!Value.Check(EnvelopeSchema, value)) throw new Error('Invalid Team v2 message envelope.');
  const message = value as Envelope;
  if (Buffer.byteLength(message.body, 'utf8') > MAX_MESSAGE_BODY_BYTES) {
    throw new Error(`Message body exceeds ${MAX_MESSAGE_BODY_BYTES} bytes.`);
  }
  const created = timestampMillis(message.createdAt, 'message createdAt');
  const expires = timestampMillis(message.expiresAt, 'message expiresAt');
  if (expires <= created || expires - created > MAX_MESSAGE_TTL_MS) {
    throw new Error('Message expiry must be after creation and within 24 hours.');
  }
  const correlated = ['request', 'reply', 'cancel'].includes(message.kind);
  if (correlated !== (message.requestId !== undefined)) {
    throw new Error('Request, reply, and cancel messages require requestId; other message kinds must omit it.');
  }
}

export function messageExpired(message: Envelope, now = Date.now()): boolean {
  return timestampMillis(message.expiresAt, 'message expiresAt') <= now;
}
