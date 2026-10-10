import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Member } from '../src/domain/member.ts';
import { MAX_MESSAGE_BODY_BYTES } from '../src/domain/message.ts';
import type { Envelope, Receipt } from '../src/domain/message.ts';
import type { Team } from '../src/domain/team.ts';
import { withStorageLock } from '../src/storage/atomic.ts';
import { InboxStore } from '../src/storage/inbox-store.ts';
import { LeaseStore } from '../src/storage/lease-store.ts';
import { TeamPaths, detectLegacyRoot } from '../src/storage/paths.ts';
import { ReceiptStore } from '../src/storage/receipt-store.ts';
import { TeamStore } from '../src/storage/team-store.ts';

const BASE = Date.parse('2026-01-01T00:00:00.000Z');
const at = (offset: number): string => new Date(BASE + offset).toISOString();

const team = (): Team => ({
  schemaVersion: 2,
  teamId: 'shop',
  state: 'open',
  createdAt: at(0),
  updatedAt: at(0),
});

const member = (memberId: string, alias: string, generation = 1): Member => ({
  schemaVersion: 2,
  teamId: 'shop',
  memberId,
  sessionId: `${memberId}-session`,
  alias,
  kind: 'external',
  generation,
  state: 'active',
  cwd: `/work/${alias}`,
  joinedAt: at(0),
  updatedAt: at(0),
});

const message = (messageId: string, toMemberId = 'backend-1', created = BASE): Envelope => ({
  schemaVersion: 2,
  messageId,
  teamId: 'shop',
  threadId: 'thread-1',
  kind: 'info',
  fromMemberId: 'pm-1',
  toMemberId,
  senderGeneration: 1,
  recipientGeneration: 1,
  createdAt: new Date(created).toISOString(),
  expiresAt: new Date(created + 60_000).toISOString(),
  body: `body for ${messageId}`,
});

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-v2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = new TeamPaths(root);
  const teams = new TeamStore(paths);
  await teams.create(team());
  await teams.createMember(member('pm-1', 'pm'));
  await teams.createMember(member('backend-1', 'backend'));
  await teams.createMember(member('frontend-1', 'frontend'));
  return { root, paths, teams };
}

test('Team v2 stores use independent files, one previous metadata copy, and no revision journal', async (t) => {
  const { paths, teams } = await setup(t);
  assert.deepEqual(await teams.list(), ['shop']);
  assert.deepEqual((await teams.listMembers('shop')).map(item => item.alias).sort(), ['backend', 'frontend', 'pm']);

  await teams.update('shop', current => ({ ...current, state: 'closing', updatedAt: at(1_000) }));
  await teams.update('shop', current => ({ ...current, state: 'closing_blocked', updatedAt: at(2_000) }));
  const previous = JSON.parse(await readFile(`${paths.teamRecord('shop')}.previous`, 'utf8')) as Team;
  assert.equal(previous.state, 'closing', 'Only the immediately previous critical record is retained');
  assert.equal(await stat(join(paths.team('shop'), 'revisions')).catch(() => undefined), undefined);
  assert.throws(() => paths.member('shop', '../escape'), /Invalid member ID/);
  assert.throws(() => paths.team('../escape'), /Invalid team ID/);

  const teamMode = (await stat(paths.team('shop'))).mode & 0o777;
  const fileMode = (await stat(paths.teamRecord('shop'))).mode & 0o777;
  assert.equal(teamMode, 0o700);
  assert.equal(fileMode, 0o600);
});

test('concurrent member writers serialize and stale generations are fenced', async (t) => {
  const { teams } = await setup(t);
  await Promise.all(Array.from({ length: 12 }, (_, index) =>
    teams.createMember(member(`worker-${index}`, `worker-${index}`))));
  assert.equal((await teams.listMembers('shop')).length, 15);

  const replaced = await teams.updateMember('shop', 'backend-1', 1, current => ({
    ...current,
    generation: 2,
    updatedAt: at(1_000),
  }));
  assert.equal(replaced.generation, 2);
  await assert.rejects(
    teams.updateMember('shop', 'backend-1', 1, current => ({ ...current, updatedAt: at(2_000) })),
    (error: unknown) => (error as { code?: string }).code === 'FENCED',
  );

  await teams.updateMember('shop', 'backend-1', 2, current => ({
    ...current, state: 'left', leftAt: at(2_000), updatedAt: at(2_000),
  }));
  await teams.createMember(member('replacement-1', 'backend'));
  await assert.rejects(teams.updateMember('shop', 'backend-1', 2, current => {
    const { leftAt: _leftAt, ...active } = current;
    return { ...active, state: 'active', generation: 3, updatedAt: at(3_000) };
  }), /already active/, 'A left identity cannot reactivate underneath a replacement using the same alias');
});

test('inboxes enforce UTF-8 validation, recipient/team quotas, TTL, pagination, and claim moves', async (t) => {
  const { paths } = await setup(t);
  const inbox = new InboxStore(paths, { recipientQuota: 2, teamQuota: 3, now: () => BASE + 1_000 });
  await Promise.all([inbox.enqueue(message('message-1')), inbox.enqueue(message('message-2'))]);
  await assert.rejects(inbox.enqueue(message('message-3')), /Recipient inbox quota/);
  await inbox.enqueue(message('message-3', 'frontend-1'));
  await assert.rejects(inbox.enqueue(message('message-1', 'frontend-1')), /already exists/,
    'messageId is unique across the team, not merely within one recipient');
  await assert.rejects(inbox.enqueue(message('message-4', 'frontend-1')), /Team inbox quota/);

  const first = await inbox.listPending('shop', 'backend-1', 1);
  assert.equal(first.messages.length, 1);
  assert.ok(first.nextCursor);
  const second = await inbox.listPending('shop', 'backend-1', 1, first.nextCursor);
  assert.equal(second.messages.length, 1);

  const claimed = await inbox.claim('shop', 'backend-1', 'message-1');
  assert.equal(claimed.messageId, 'message-1');
  assert.equal(await inbox.readPending('shop', 'backend-1', 'message-1'), undefined);
  await inbox.release('shop', 'backend-1', 'message-1');
  assert.equal((await inbox.readPending('shop', 'backend-1', 'message-1'))?.messageId, 'message-1');

  await assert.rejects(inbox.enqueue(message('expired-1', 'frontend-1', BASE - 120_000)), /already expired/);
  await assert.rejects(inbox.enqueue({ ...message('large-1', 'frontend-1'), body: 'ñ'.repeat(MAX_MESSAGE_BODY_BYTES / 2 + 1) }), new RegExp(`exceeds ${MAX_MESSAGE_BODY_BYTES} bytes`));
});

test('every valid body at the size bound fits the bounded serialized envelope', async (t) => {
  const { paths } = await setup(t);
  const inbox = new InboxStore(paths, { now: () => BASE + 1_000 });
  const escaped = { ...message('escaped-body'), body: '\0'.repeat(MAX_MESSAGE_BODY_BYTES) };
  await inbox.enqueue(escaped);
  assert.equal((await inbox.readPending('shop', 'backend-1', 'escaped-body'))?.body.length, MAX_MESSAGE_BODY_BYTES);
});

test('concurrent inbox writes preserve every admitted message and reclaim a dead stale lock', async (t) => {
  const { paths } = await setup(t);
  const inbox = new InboxStore(paths, { recipientQuota: 30, teamQuota: 30, now: () => BASE + 1_000 });
  const lockPath = paths.inboxLock('shop');
  await writeFile(lockPath, JSON.stringify({ pid: 999_999_999, token: 'abandoned', createdAt: at(-60_000) }), { mode: 0o600 });
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);

  await Promise.all(Array.from({ length: 20 }, (_, index) => inbox.enqueue(message(`parallel-${String(index).padStart(2, '0')}`))));
  assert.equal((await inbox.listPending('shop', 'backend-1', 100)).messages.length, 20);
  assert.equal(await stat(lockPath).catch(() => undefined), undefined);
});

test('stale lock recovery remains mutually exclusive for concurrent reclaimers', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-v2-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = join(root, 'record.lock');
  await writeFile(lockPath, JSON.stringify({ pid: 999_999_999, token: 'abandoned' }), { mode: 0o600 });
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);
  let active = 0;
  let maximum = 0;
  await Promise.all(Array.from({ length: 8 }, () => withStorageLock(lockPath, async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
  })));
  assert.equal(maximum, 1);
  assert.equal(await stat(`${lockPath}.gate`).catch(() => undefined), undefined);

  await writeFile(`${lockPath}.gate`, JSON.stringify({ pid: 999_999_999, token: 'abandoned-gate' }), { mode: 0o600 });
  await utimes(`${lockPath}.gate`, old, old);
  await withStorageLock(lockPath, async () => {}, { staleMs: 10, retryMs: 1 });
  assert.equal(await stat(`${lockPath}.gate`).catch(() => undefined), undefined,
    'A gate abandoned by a dead process is reclaimed without leaving the lock held');
});

test('corruption, future schemas, abandoned temps, and symlinked sensitive paths fail closed', async (t) => {
  const { root, paths, teams } = await setup(t);
  const original = await readFile(paths.teamRecord('shop'), 'utf8');
  const future = JSON.stringify({ ...JSON.parse(original), schemaVersion: 3 });
  await writeFile(paths.teamRecord('shop'), future, { mode: 0o600 });
  await assert.rejects(teams.read('shop'), /Invalid record preserved/);
  assert.equal(await readFile(paths.teamRecord('shop'), 'utf8'), future, 'Unknown schemas are preserved');
  await writeFile(paths.teamRecord('shop'), '{', { mode: 0o600 });
  await assert.rejects(teams.read('shop'), /Corrupt JSON record preserved/);
  assert.equal(await readFile(paths.teamRecord('shop'), 'utf8'), '{', 'Truncated JSON is preserved');

  await writeFile(join(paths.teams(), '.shop.crashed.tmp'), 'partial', { mode: 0o600 });
  assert.deepEqual(await teams.list(), ['shop'], 'A crash before directory rename does not publish another team');

  const outside = join(root, 'outside-inbox');
  await rm(paths.inbox('shop'), { recursive: true, force: true });
  await symlink(outside, paths.inbox('shop'));
  const inbox = new InboxStore(paths, { now: () => BASE + 1_000 });
  await assert.rejects(inbox.enqueue(message('unsafe-1')), /Unsafe storage directory/);
  assert.equal(await stat(outside).catch(() => undefined), undefined, 'No content is created through the symlink');

  const redirected = join(root, 'redirected-home');
  const parentLink = join(root, 'linked-home');
  await mkdir(redirected, { mode: 0o700 });
  await symlink(redirected, parentLink);
  await assert.rejects(new TeamStore(new TeamPaths(join(parentLink, 'pi-team'))).create(team()), /Unsafe storage ancestor/);
  await assert.rejects(new TeamStore(new TeamPaths(join(parentLink, 'missing', 'pi-team'))).create(team()), /Unsafe storage ancestor/);
  assert.equal(await stat(join(redirected, 'pi-team')).catch(() => undefined), undefined,
    'A symlinked storage parent is rejected before creating the root');
  assert.equal(await stat(join(redirected, 'missing')).catch(() => undefined), undefined,
    'A symlinked grandparent is rejected before creating an absent intermediate parent');
});

test('lease replacement fences old tokens and receipts expire only after terminal state', async (t) => {
  const { paths } = await setup(t);
  let now = BASE;
  const leases = new LeaseStore(paths, { now: () => now, maxTtlMs: 10_000 });
  const first = await leases.acquire({
    teamId: 'shop', leaseId: 'presence-backend', kind: 'presence', holderId: 'backend-1',
    resourceId: 'backend-1', ttlMs: 1_000,
  });
  await assert.rejects(leases.acquire({
    teamId: 'shop', leaseId: 'presence-backend', kind: 'presence', holderId: 'frontend-1',
    resourceId: 'backend-1', ttlMs: 1_000,
  }), /is held/);
  now += 2_000;
  const second = await leases.acquire({
    teamId: 'shop', leaseId: 'presence-backend', kind: 'presence', holderId: 'frontend-1',
    resourceId: 'backend-1', ttlMs: 1_000,
  });
  assert.equal(second.generation, first.generation + 1);
  await assert.rejects(
    leases.release('shop', first.leaseId, first.holderId, first.token, first.generation),
    (error: unknown) => (error as { code?: string }).code === 'FENCED',
  );
  await leases.release('shop', second.leaseId, second.holderId, second.token, second.generation);
  const third = await leases.acquire({
    teamId: 'shop', leaseId: 'presence-backend', kind: 'presence', holderId: 'pm-1',
    resourceId: 'backend-1', ttlMs: 1_000,
  });
  assert.equal(third.generation, second.generation + 1, 'Release retains the monotonic generation tombstone');

  const receipts = new ReceiptStore(paths, { now: () => now, terminalTtlMs: 1_000 });
  const delivered: Receipt = {
    schemaVersion: 2, teamId: 'shop', messageId: 'message-1', recipientId: 'backend-1',
    status: 'delivered', at: new Date(now).toISOString(),
  };
  await receipts.record(delivered);
  now += 1_000;
  await receipts.record({ ...delivered, at: new Date(now).toISOString() });
  assert.equal((await receipts.read('shop', 'backend-1', 'message-1'))?.at, delivered.at,
    'Repeating one receipt state is idempotent and preserves its first timestamp');
  now += 1_000;
  assert.equal(await receipts.purgeExpired('shop', 'backend-1'), 0, 'Nonterminal receipts do not expire');
  await receipts.record({ ...delivered, status: 'replied', at: new Date(now).toISOString() });
  now += 2_000;
  assert.equal(await receipts.purgeExpired('shop', 'backend-1'), 1);
  assert.equal(await receipts.read('shop', 'backend-1', 'message-1'), undefined);
});

test('legacy detection performs a preserve-only root check', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-legacy-detect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = join(root, 'teams');
  await mkdir(join(legacy, 'unreadable', 'nested'), { recursive: true, mode: 0o700 });
  const before = await readdir(legacy);
  assert.deepEqual(await detectLegacyRoot(legacy), { path: legacy, present: true, kind: 'directory' });
  assert.deepEqual(await readdir(legacy), before, 'Detection neither migrates nor removes legacy content');
  assert.equal((await detectLegacyRoot(join(root, 'missing'))).present, false);
});
