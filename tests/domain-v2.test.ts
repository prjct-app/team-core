import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertLease, sameLeaseOwner, type Lease } from '../src/domain/lease.ts';
import { assertEnvelope, assertReceipt, MAX_MESSAGE_BODY_BYTES, type Envelope } from '../src/domain/message.ts';
import { assertRequestTransition, requestTerminal } from '../src/domain/request.ts';
import { assertTeam, assertTeamTransition, type Team } from '../src/domain/team.ts';

const at = (millis: number): string => new Date(millis).toISOString();

const envelope = (body = 'hello'): Envelope => ({
  schemaVersion: 2,
  messageId: 'message-1',
  teamId: 'shop',
  threadId: 'thread-1',
  kind: 'info',
  fromMemberId: 'pm-1',
  toMemberId: 'backend-1',
  senderGeneration: 1,
  recipientGeneration: 2,
  createdAt: at(1_000),
  expiresAt: at(2_000),
  body,
});

test('Team v2 domain schemas reject future versions and invalid lifecycle transitions', () => {
  const team: Team = { schemaVersion: 2, teamId: 'shop', state: 'open', createdAt: at(1_000), updatedAt: at(1_000) };
  assert.doesNotThrow(() => assertTeam(team));
  assert.throws(() => assertTeam({ ...team, schemaVersion: 3 }), /Invalid Team v2/);
  assert.doesNotThrow(() => assertTeamTransition('open', 'closing'));
  assert.doesNotThrow(() => assertTeamTransition('closing', 'closing_blocked'));
  assert.doesNotThrow(() => assertTeamTransition('closing_blocked', 'closing'));
  assert.throws(() => assertTeamTransition('open', 'closed'), /Invalid team transition/);
  assert.throws(() => assertTeamTransition('closed', 'open'), /Invalid team transition/);
});

test('message validation uses UTF-8 bytes, bounded TTL, and explicit request correlation', () => {
  assert.doesNotThrow(() => assertEnvelope(envelope('ñ'.repeat(MAX_MESSAGE_BODY_BYTES / 2))));
  assert.throws(() => assertEnvelope(envelope('ñ'.repeat(MAX_MESSAGE_BODY_BYTES / 2 + 1))), new RegExp(`exceeds ${MAX_MESSAGE_BODY_BYTES} bytes`));
  assert.throws(() => assertEnvelope({ ...envelope(), expiresAt: at(24 * 60 * 60 * 1000 + 1_001) }), /within 24 hours/);
  assert.throws(() => assertEnvelope({ ...envelope(), kind: 'request' }), /require requestId/);
  assert.doesNotThrow(() => assertEnvelope({ ...envelope(), kind: 'request', requestId: 'request-1' }));
  assert.throws(() => assertEnvelope({ ...envelope(), requestId: 'request-1' }), /must omit/);
});

test('request transitions and receipts have explicit terminal semantics', () => {
  assert.doesNotThrow(() => assertRequestTransition('queued', 'delivered'));
  assert.doesNotThrow(() => assertRequestTransition('accepted', 'cancelled'));
  assert.throws(() => assertRequestTransition('replied', 'cancelled'), /Invalid request transition/);
  assert.equal(requestTerminal('replied'), true);
  assert.equal(requestTerminal('accepted'), false);
  assert.doesNotThrow(() => assertReceipt({
    schemaVersion: 2,
    teamId: 'shop',
    messageId: 'message-1',
    recipientId: 'backend-1',
    status: 'delivered',
    at: at(1_000),
  }));
});

test('lease ownership requires both token and generation', () => {
  const lease: Lease = {
    schemaVersion: 2,
    leaseId: 'presence-backend',
    teamId: 'shop',
    kind: 'presence',
    holderId: 'backend-1',
    resourceId: 'backend-1',
    token: '0123456789abcdef0123456789abcdef',
    generation: 4,
    acquiredAt: at(1_000),
    expiresAt: at(2_000),
  };
  assert.doesNotThrow(() => assertLease(lease));
  assert.equal(sameLeaseOwner(lease, lease.token, 4), true);
  assert.equal(sameLeaseOwner(lease, lease.token, 3), false);
  assert.equal(sameLeaseOwner(lease, `${lease.token}x`, 4), false);
  assert.throws(() => assertLease({ ...lease, expiresAt: lease.acquiredAt }), /after acquisition/);
});
