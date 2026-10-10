import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startBridge, type BridgeEvent } from '../src/bridge.ts';
import { TeamRuntime } from '../src/runtime/team-runtime.ts';
import { TeamPaths } from '../src/storage/paths.ts';
import { TeamSession } from '../src/session.ts';

const call = (socket: string, op: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; value?: any; error?: string }> =>
  new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, agent: false, path: '/call', method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk)).on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    });
    req.on('error', reject).end(JSON.stringify({ op, args }));
  });

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('Timed out.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function setup(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'team-bridge-'));
  // Bridges stop before the folder goes: a running poll would write into a half-removed store.
  const bridges: { stop: (reason: string) => Promise<void> }[] = [];
  t.after(async () => { for (const bridge of bridges) await bridge.stop('test over'); await rm(dir, { recursive: true, force: true }); });
  const root = join(dir, 'store');
  const events: BridgeEvent[] = [];
  const socket = join(dir, 'run', 'b.sock');
  const bridge = await startBridge({ socket, sessionId: 'claude-1', cwd: '/work/claude', root, pollMs: 10, heartbeatMs: 100, emit: event => events.push(event) });
  bridges.push(bridge);
  // The other terminal is the same session logic Pi runs.
  const pi = new TeamSession(new TeamRuntime(new TeamPaths(root)));
  return { root, socket, events, bridge, bridges, pi };
}

test('a bridge session and a Pi session share one team: presence, activity and messages both ways', async t => {
  const { socket, events, pi } = await setup(t);
  assert.deepEqual(events[0], { type: 'ready', protocol: 1, schemaVersion: 2, socket });
  assert.ok((await stat(join(socket, '..'))).mode & 0o700);

  await pi.join({ team: 'shop', role: 'backend', sessionId: 'pi-1', cwd: '/work/pi' });
  const planned = await call(socket, 'plan', { team: 'shop', role: 'claude' });
  assert.deepEqual(planned, { ok: true, value: { create: false } });
  const joined = await call(socket, 'join', { team: 'shop', role: 'claude' });
  assert.equal(joined.ok, true);
  assert.equal(joined.value.created, false);
  assert.equal(joined.value.saved.role, 'claude');

  await call(socket, 'activity', { state: 'working', focus: 'Review the login copy' });
  const mates = await pi.teammates();
  const claude = mates.find(mate => mate.role === 'claude');
  assert.equal(claude?.online, true);
  assert.equal(claude?.activity?.state, 'working');
  assert.equal(claude?.activity?.focus, 'Review the login copy');

  // Pi → Claude: the bridge receives it once and emits it.
  await pi.send('claude', 'question', 'Is 401 right for a bad password?');
  await until(() => events.some(event => event.type === 'messages'));
  const delivered = events.filter(event => event.type === 'messages').flatMap(event => event.type === 'messages' ? event.messages : []);
  assert.deepEqual(delivered, [{ from: 'backend', kind: 'question', body: 'Is 401 right for a bad password?' }]);

  // Claude → Pi: submitted to the Pi member's inbox, received there exactly once.
  const sent = await call(socket, 'send', { to: 'backend', kind: 'info', body: 'Yes, 401.' });
  assert.equal(sent.ok, true);
  assert.equal(sent.value.status, 'submitted');
  assert.deepEqual(await pi.receive(), [{ from: 'claude', kind: 'info', body: 'Yes, 401.' }]);
  assert.deepEqual(await pi.receive(), []);

  // The timeline Pi's panel reads has the bridge member's join, work and message.
  const timeline = (await pi.events()).map(event => `${event.type}:${event.role}${event.to ? `>${event.to}` : ''}`);
  assert.ok(timeline.includes('joined:claude'));
  assert.ok(timeline.includes('working:claude'));
  assert.ok(timeline.includes('message:claude>backend'));
});

test('errors come back as values, never as a broken bridge', async t => {
  const { socket } = await setup(t);
  assert.deepEqual(await call(socket, 'nope'), { ok: false, error: 'Unknown op.' });
  const notJoined = await call(socket, 'send', { to: 'backend', body: 'hi' });
  assert.equal(notJoined.ok, false);
  assert.match(notJoined.error!, /Not in a team/);
  await call(socket, 'join', { team: 'shop', role: 'claude' });
  const offline = await call(socket, 'send', { to: 'ghost', body: 'hi' });
  assert.match(offline.error!, /No "ghost" in team shop/);
  assert.equal((await call(socket, 'current')).value.role, 'claude');
});

test('stopping goes offline but keeps the role for the same session', async t => {
  const { root, socket, events, bridge, bridges, pi } = await setup(t);
  await pi.join({ team: 'shop', role: 'backend', sessionId: 'pi-1', cwd: '/work/pi' });
  const { value } = await call(socket, 'join', { team: 'shop', role: 'claude' });
  await bridge.stop('closed');
  assert.deepEqual(events.at(-1), { type: 'stopped', reason: 'closed' });
  await assert.rejects(stat(socket));
  assert.equal((await pi.teammates()).find(mate => mate.role === 'claude')?.online, false);

  // The same session starts a new bridge and rejoins the same member by ID.
  const again: BridgeEvent[] = [];
  const next = await startBridge({ socket, sessionId: 'claude-1', cwd: '/work/claude', root, pollMs: 10, emit: event => again.push(event) });
  bridges.push(next);
  const rejoined = await call(socket, 'join', { team: 'shop', role: 'claude', saved: value.saved });
  assert.equal(rejoined.ok, true);
  assert.equal(rejoined.value.saved.memberId, value.saved.memberId);
});

test('a removed member is told once, with the words Pi uses', async t => {
  const { socket, events, pi } = await setup(t);
  await pi.join({ team: 'shop', role: 'backend', sessionId: 'pi-1', cwd: '/work/pi' });
  await call(socket, 'join', { team: 'shop', role: 'claude' });
  await pi.removeMember('claude');
  await until(() => events.some(event => event.type === 'lost'));
  const lost = events.find(event => event.type === 'lost');
  assert.equal(lost?.type === 'lost' && lost.text, 'You were removed from shop by backend.');
  assert.equal((await call(socket, 'current')).value, null);
});

test('a socket path longer than Unix allows is refused, never silently cut', async () => {
  const socket = join(tmpdir(), 'x'.repeat(120), 'b.sock');
  await assert.rejects(startBridge({ socket, sessionId: 's', cwd: '/', emit: () => {} }), /Unix sockets allow 103/);
});

test('a role online in another terminal is taken when the joiner asks to steal it; that terminal learns it was taken', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'team-steal-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'store');
  const first = new TeamSession(new TeamRuntime(new TeamPaths(root)));
  const second = new TeamSession(new TeamRuntime(new TeamPaths(root)));
  await first.join({ team: 'shop', role: 'ux', sessionId: 'old', cwd: '/work/old' });

  await assert.rejects(second.plan('shop', 'ux', 'new'), /is online in another terminal/);
  assert.deepEqual(await second.plan('shop', 'ux', 'new', { steal: true }), { create: false, takeFrom: '/work/old', online: true });
  await assert.rejects(second.join({ team: 'shop', role: 'ux', sessionId: 'new', cwd: '/work/new' }), /belongs to another/);
  await second.join({ team: 'shop', role: 'ux', sessionId: 'new', cwd: '/work/new', steal: true });
  assert.equal(second.saved()?.memberId, first.saved()?.memberId, 'Same member: its inbox and history move with it');

  const beat = await first.heartbeat();
  assert.equal(beat.lost?.role, 'ux');
  assert.deepEqual(await first.fate(beat.lost!.teamId, beat.lost!.memberId, 'old'), { reason: 'taken', cwd: '/work/new' });
  const mate = (await second.teammates()).find(entry => entry.role === 'ux');
  assert.equal(mate?.online, true);
  assert.equal(mate?.self, true);
});
