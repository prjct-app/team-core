import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Team } from '../src/domain/team.ts';
import { DeliveryService } from '../src/runtime/delivery.ts';
import { MembershipService, type Membership } from '../src/runtime/membership.ts';
import { PresenceService } from '../src/runtime/presence.ts';
import { TeamReconciler } from '../src/runtime/reconciler.ts';
import { RequestService } from '../src/runtime/requests.ts';
import { ResourceLeaseService } from '../src/runtime/resources.ts';
import { InboxStore } from '../src/storage/inbox-store.ts';
import { LeaseStore } from '../src/storage/lease-store.ts';
import { TeamPaths } from '../src/storage/paths.ts';
import { ReceiptStore } from '../src/storage/receipt-store.ts';
import { TeamStore } from '../src/storage/team-store.ts';

const BASE = Date.parse('2026-02-01T00:00:00.000Z');

type RuntimeFixture = {
  readonly paths: TeamPaths;
  readonly teams: TeamStore;
  readonly inbox: InboxStore;
  readonly receipts: ReceiptStore;
  readonly memberships: MembershipService;
  readonly delivery: DeliveryService;
  readonly requests: RequestService;
  readonly resources: ResourceLeaseService;
  readonly reconciler: TeamReconciler;
  readonly setNow: (value: number) => void;
  readonly join: (alias: string, session?: string, kind?: 'external' | 'supervised') => Promise<Membership>;
};

async function setup(t: TestContext): Promise<RuntimeFixture> {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-runtime-v2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = BASE;
  const clock = () => now;
  const paths = new TeamPaths(root);
  const teams = new TeamStore(paths);
  const leases = new LeaseStore(paths, { now: clock });
  const inbox = new InboxStore(paths, { now: clock });
  const receipts = new ReceiptStore(paths, { now: clock });
  const presence = new PresenceService(teams, leases, { ttlMs: 10_000, now: clock });
  const memberships = new MembershipService(paths, teams, presence, clock);
  const delivery = new DeliveryService(memberships, inbox, receipts, leases, { leaseMs: 1_000, now: clock });
  const requests = new RequestService(paths, teams, memberships, delivery, inbox, receipts, clock);
  const resources = new ResourceLeaseService(memberships, leases, clock);
  const reconciler = new TeamReconciler(paths, teams, inbox, receipts, presence, delivery, requests, clock);
  const team: Team = {
    schemaVersion: 2,
    teamId: 'shop',
    state: 'open',
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
  await teams.create(team);
  return {
    paths,
    teams,
    inbox,
    receipts,
    memberships,
    delivery,
    requests,
    resources,
    reconciler,
    setNow(value) { now = value; },
    join: (alias, session = `${alias}-session`, kind = 'external') => memberships.join({
      teamId: 'shop', alias, sessionId: session, cwd: `/work/${alias}`, kind,
    }),
  };
}

test('membership presence fences replaced generations and preserves one offline address', async (t) => {
  const runtime = await setup(t);
  const first = await runtime.join('backend');
  await assert.rejects(runtime.join('backend', 'other-session'), /already active/);
  await runtime.memberships.leave(first);
  const second = await runtime.join('backend', 'replacement-session');
  assert.equal(second.memberId, first.memberId, 'Rejoining an alias preserves its durable inbox address');
  assert.equal(second.memberGeneration, first.memberGeneration + 1);
  await assert.rejects(runtime.memberships.heartbeat(first), (error: unknown) =>
    (error as { code?: string }).code === 'FENCED');
  await runtime.memberships.heartbeat(second);
  assert.equal((await runtime.memberships.peers(second))[0].status, 'online');

  const pm = await runtime.join('pm');
  const generationBound = await runtime.requests.send(pm, { to: 'backend', kind: 'request', body: 'For generation two.' });
  assert.equal(generationBound.recipientGeneration, second.memberGeneration);
  await runtime.memberships.leave(second);
  const third = await runtime.join('backend', 'third-session');
  await assert.rejects(runtime.delivery.claim(third, generationBound.messageId), (error: unknown) =>
    (error as { code?: string }).code === 'FENCED');
  assert.equal((await runtime.delivery.inboxItems(third)).items.length, 0,
    'A replacement cannot consume work targeted at the previous online generation');
});

test('a failed outgoing cancellation retains durable membership ownership', async (t) => {
  const runtime = await setup(t);
  const member = await runtime.join('lead');
  t.mock.method(runtime.requests, 'cancelOutgoing', async () => { throw new Error('injected cancellation failure'); });
  await assert.rejects(runtime.requests.leave(member), /injected cancellation failure/);
  assert.equal((await runtime.memberships.assertOwner(member)).state, 'active');
});

test('offline requests are delivered after rejoin and require an explicit correlated reply', async (t) => {
  const runtime = await setup(t);
  const pm = await runtime.join('pm');
  const backend = await runtime.join('backend');
  await runtime.memberships.leave(backend);
  const request = await runtime.requests.send(pm, {
    to: 'backend', kind: 'request', body: 'Review the API contract.', ttlMs: 60_000,
  });
  assert.equal(request.recipientGeneration, undefined, 'Offline delivery is addressed to the durable member, not a stale generation');

  const returned = await runtime.join('backend', 'backend-returned');
  await runtime.delivery.claim(returned, request.messageId);
  const read = await runtime.requests.read(returned, request.messageId);
  assert.equal(read.message?.body, 'Review the API contract.');
  const reply = await runtime.requests.reply(returned, request.requestId!, 'Contract reviewed.');
  assert.equal(reply.accepted, true);

  await runtime.delivery.claim(pm, `reply-${request.requestId}`);
  const received = await runtime.requests.read(pm, `reply-${request.requestId}`);
  assert.equal(received.discarded, false);
  assert.equal(received.message?.body, 'Contract reviewed.');
  assert.equal(await runtime.delivery.inboxItems(pm).then(result => result.items.length), 0);
});

test('an active delivery claim can be token-fenced and renewed beyond its original lease', async (t) => {
  const runtime = await setup(t);
  const pm = await runtime.join('pm');
  const backend = await runtime.join('backend');
  const request = await runtime.requests.send(pm, { to: 'backend', kind: 'request', body: 'Take enough time to verify this.' });
  const original = await runtime.delivery.claim(backend, request.messageId);
  await runtime.requests.read(backend, request.messageId);
  runtime.setNow(BASE + 900);
  const renewed = await runtime.delivery.renew(backend, request.messageId);
  assert.equal(renewed.token, original.token);
  assert.equal(renewed.generation, original.generation);
  runtime.setNow(BASE + 1_500);
  assert.equal((await runtime.requests.reply(backend, request.messageId, 'Verified after renewal.')).accepted, true);
});

test('sender cancellation is durable and a late reply is discarded', async (t) => {
  const runtime = await setup(t);
  const pm = await runtime.join('pm');
  const backend = await runtime.join('backend');
  const request = await runtime.requests.send(pm, { to: 'backend', kind: 'request', body: 'Run a destructive migration.' });
  await runtime.delivery.claim(backend, request.messageId);
  await runtime.requests.read(backend, request.messageId);

  assert.equal(await runtime.requests.cancel(pm, request.requestId!), true);
  assert.equal(await runtime.requests.isCancelled(backend, request.requestId!), true);
  const late = await runtime.requests.reply(backend, request.requestId!, 'Migration completed too late.');
  assert.deepEqual(late, { accepted: false, reason: 'cancelled' });
  assert.equal((await runtime.delivery.inboxItems(pm)).items.some(item => item.kind === 'reply'), false,
    'Cancellation never reopens through a late reply');
  assert.equal((await runtime.delivery.inboxItems(backend)).items.some(item => item.kind === 'cancel'), true,
    'The recipient also receives a durable cancellation envelope');
});

test('a claimed request cannot reply after its envelope TTL', async (t) => {
  const runtime = await setup(t);
  const pm = await runtime.join('pm');
  const backend = await runtime.join('backend');
  const request = await runtime.requests.send(pm, { to: 'backend', kind: 'request', body: 'Short lived.', ttlMs: 500 });
  await runtime.delivery.claim(backend, request.messageId);
  await runtime.requests.read(backend, request.messageId);
  runtime.setNow(BASE + 600);
  const reply = await runtime.requests.reply(backend, request.requestId!, 'Too late.');
  assert.deepEqual(reply, { accepted: false, reason: 'expired' });
  assert.equal((await runtime.delivery.inboxItems(pm)).items.some(item => item.kind === 'reply'), false);
  assert.equal(await runtime.requests.requestState(pm, request.requestId!), 'expired');
});

test('leaving a sender durably cancels every outstanding request without closing recipients', async (t) => {
  const runtime = await setup(t);
  const pm = await runtime.join('pm');
  const backend = await runtime.join('backend');
  const first = await runtime.requests.send(pm, { to: 'backend', kind: 'request', body: 'First request.' });
  const second = await runtime.requests.send(pm, { to: 'backend', kind: 'request', body: 'Second request.' });
  assert.equal(await runtime.requests.leave(pm), 2);
  const inbox = await runtime.delivery.inboxItems(backend);
  assert.equal(inbox.items.some(item => item.messageId === first.messageId || item.messageId === second.messageId), false);
  assert.equal(inbox.items.filter(item => item.kind === 'cancel').length, 2);
  await runtime.memberships.heartbeat(backend);
});

test('delivery read and release serialize so an exposed body is never requeued', async (t) => {
  const runtime = await setup(t);
  const pm = await runtime.join('pm');
  const backend = await runtime.join('backend');
  const message = await runtime.requests.send(pm, { to: 'backend', kind: 'request', body: 'Serialize delivery.' });
  await runtime.delivery.claim(backend, message.messageId);
  const [read, release] = await Promise.allSettled([
    runtime.requests.read(backend, message.messageId),
    runtime.delivery.release(backend, message.messageId),
  ]);
  const queued = (await runtime.delivery.inboxItems(backend)).items.some(item => item.messageId === message.messageId);
  assert.equal(read.status === 'fulfilled' && queued, false);
  assert.equal(read.status === 'fulfilled' || release.status === 'fulfilled', true);
});

test('delivery marks deduplication before injection and never automatically replays failures', async (t) => {
  const runtime = await setup(t);
  const pm = await runtime.join('pm');
  const backend = await runtime.join('backend', 'backend-supervised', 'supervised');
  await runtime.requests.send(pm, { to: 'backend', kind: 'info', body: 'Display only.' });
  assert.equal(await runtime.delivery.deliverNextRequest(backend, true, async () => {}), undefined,
    'Only requests are eligible for automatic activation');

  await runtime.requests.send(pm, { to: 'backend', kind: 'request', body: 'Apply one side effect.' });
  assert.equal(await runtime.delivery.deliverNextRequest(backend, false, async () => {}), undefined,
    'A supervised peer still requires explicit human enablement');
  let injections = 0;
  await assert.rejects(runtime.delivery.deliverNextRequest(backend, true, async () => {
    injections += 1;
    throw new Error('provider failed after injection');
  }), /provider failed/);
  assert.equal(injections, 1);
  assert.equal(await runtime.delivery.deliverNextRequest(backend, true, async () => { injections += 1; }), undefined);
  assert.equal(injections, 1, 'A failed delivered request is not reinjected automatically');
});

test('reconciliation repairs cancellation and reply crash windows from durable evidence', async (t) => {
  const runtime = await setup(t);
  const pm = await runtime.join('pm');
  const backend = await runtime.join('backend');
  const cancelled = await runtime.requests.send(pm, { to: 'backend', kind: 'request', body: 'Cancel before publication.' });
  await runtime.receipts.record({
    schemaVersion: 2,
    teamId: 'shop',
    messageId: cancelled.messageId,
    recipientId: backend.memberId,
    status: 'cancelled',
    at: new Date(BASE).toISOString(),
  });
  await runtime.reconciler.reconcile('shop');
  const repairedCancel = await runtime.delivery.inboxItems(backend);
  assert.equal(repairedCancel.items.some(item => item.messageId === cancelled.messageId), false);
  assert.equal(repairedCancel.items.some(item => item.messageId === `cancel-${cancelled.messageId}`), true);

  const request = await runtime.requests.send(pm, { to: 'backend', kind: 'request', body: 'Reply across a crash.' });
  await runtime.delivery.claim(backend, request.messageId);
  await runtime.requests.read(backend, request.messageId);
  await runtime.inbox.enqueue({
    schemaVersion: 2,
    messageId: `reply-${request.messageId}`,
    teamId: 'shop',
    threadId: request.threadId,
    requestId: request.messageId,
    kind: 'reply',
    fromMemberId: backend.memberId,
    toMemberId: pm.memberId,
    senderGeneration: backend.memberGeneration,
    recipientGeneration: pm.memberGeneration,
    createdAt: new Date(BASE).toISOString(),
    expiresAt: new Date(BASE + 60_000).toISOString(),
    body: 'Durable reply body.',
  });
  await runtime.reconciler.reconcile('shop');
  assert.equal(await runtime.requests.requestState(pm, request.messageId), 'replied');
  const received = await runtime.requests.receive(pm, `reply-${request.messageId}`);
  assert.equal(received.message?.body, 'Durable reply body.');
});

test('reconciliation expires queued messages and fails delivered work after its claim is lost', async (t) => {
  const runtime = await setup(t);
  const pm = await runtime.join('pm');
  const backend = await runtime.join('backend');
  const active = await runtime.requests.send(pm, { to: 'backend', kind: 'request', body: 'May be partial.', ttlMs: 5_000 });
  await runtime.delivery.claim(backend, active.messageId);
  await runtime.requests.read(backend, active.messageId);
  await runtime.requests.send(pm, { to: 'backend', kind: 'question', body: 'Expires soon.', ttlMs: 500 });

  runtime.setNow(BASE + 2_000);
  const result = await runtime.reconciler.reconcile('shop');
  assert.equal(result.failedClaims, 1);
  assert.equal(result.expiredMessages, 1);
  assert.equal((await runtime.delivery.inboxItems(backend)).items.length, 0);
});

test('resource claims are advisory, token-fenced, and handed off only after release', async (t) => {
  const runtime = await setup(t);
  const pm = await runtime.join('pm');
  const backend = await runtime.join('backend');
  const first = await runtime.resources.claim(pm, '/repo/src/api.ts', 5_000);
  await assert.rejects(runtime.resources.claim(backend, '/repo/src/api.ts', 5_000), (error: unknown) =>
    (error as { code?: string }).code === 'LEASE_HELD');
  await runtime.resources.release(pm, '/repo/src/api.ts', first.token, first.generation);
  const second = await runtime.resources.claim(backend, '/repo/src/api.ts', 5_000);
  assert.equal(second.generation, first.generation + 1);
  await assert.rejects(runtime.resources.release(pm, '/repo/src/api.ts', first.token, first.generation), (error: unknown) =>
    (error as { code?: string }).code === 'FENCED');
});
