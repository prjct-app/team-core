import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { lstat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { TeamRuntime } from './runtime/team-runtime.ts';
import { TeamPaths } from './storage/paths.ts';
import { ensurePrivateDirectory } from './storage/atomic.ts';
import { MESSAGE_KINDS, TeamSession, type Activity, type Fate, type Incoming, type MessageKind, type Saved } from './session.ts';
import { clean } from './text.ts';

/** Bumped when an op or an event changes shape; a client refuses a bridge it does not speak. */
export const BRIDGE_PROTOCOL = 1;
export const SCHEMA_VERSION = 2;
/** The longest Unix socket path every platform accepts (macOS: 104 bytes with the terminator). */
export const MAX_SOCKET_BYTES = 103;

/** What the bridge writes on stdout, one JSON object per line. */
export type BridgeEvent =
  | { readonly type: 'ready'; readonly protocol: number; readonly schemaVersion: number; readonly socket: string }
  | { readonly type: 'messages'; readonly messages: readonly Incoming[] }
  | { readonly type: 'lost'; readonly team: string; readonly role: string; readonly fate: Fate; readonly text: string }
  | { readonly type: 'renamed'; readonly team: string; readonly role: string }
  | { readonly type: 'stopped'; readonly reason: string };

export type BridgeOptions = {
  /** Unix socket the client calls, in a private directory, near 100 bytes at most. */
  readonly socket: string;
  /** The client session that owns the role: a rejoin from another session is a takeover. */
  readonly sessionId: string;
  readonly cwd: string;
  /** Storage root; defaults to ${PRJCT_HOME:-~/.prjct}/pi-team, the folder Pi uses. */
  readonly root?: string;
  readonly pollMs?: number;
  readonly heartbeatMs?: number;
  readonly now?: () => number;
  readonly emit: (event: BridgeEvent) => void;
  /** Called after the bridge stopped: the process exits here. */
  readonly onStop?: (reason: string) => void;
};

export type Bridge = { readonly stop: (reason: string) => Promise<void> };

type Args = Record<string, unknown>;
const text = (args: Args, key: string): string => {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing "${key}".`);
  return value.trim();
};
const optional = (args: Args, key: string): string | undefined => typeof args[key] === 'string' && args[key] ? args[key] as string : undefined;
const kindOf = (value: unknown): MessageKind => (MESSAGE_KINDS as readonly string[]).includes(value as string) ? value as MessageKind : 'info';

/** The final words a terminal shows when it lost its place, as Pi words them. */
export function lostText(lost: Saved, fate: Fate): string {
  return fate.reason === 'deleted' ? `Team ${lost.team} was deleted.`
    : fate.reason === 'removed' ? `You were removed from ${lost.team} by ${fate.by}.`
    : fate.reason === 'taken' ? `${lost.role} in ${lost.team} was taken over by the session in ${fate.cwd}; this one left.`
    : `This session was opened in another terminal, which now holds ${lost.role} in ${lost.team}; this one left.`;
}

/**
 * One client session's place in a team, served over a Unix socket. It runs
 * the same session logic as Pi: one queue for every storage action, a poll
 * that receives each message exactly once, and a heartbeat that renews
 * presence and notices removal, deletion, takeover and renames.
 */
export async function startBridge(options: BridgeOptions): Promise<Bridge> {
  const now = options.now ?? Date.now;
  const session = new TeamSession(new TeamRuntime(new TeamPaths(options.root), now), now);
  const serial = { value: Promise.resolve() as Promise<unknown> };
  const queue = <T>(action: () => Promise<T>): Promise<T> => {
    const next = serial.value.then(action); serial.value = next.catch(() => {}); return next;
  };
  const state = { beatAt: 0, stopped: false, polling: false };

  const ops: Readonly<Record<string, (args: Args) => Promise<unknown>>> = {
    current: async () => session.saved() ?? null,
    teams: async () => session.teams(),
    plan: async args => session.plan(text(args, 'team'), text(args, 'role'), options.sessionId, { steal: args.steal === true }),
    join: async args => {
      const saved = args.saved && typeof args.saved === 'object' ? args.saved as Saved : undefined;
      const result = await session.join({
        team: text(args, 'team'), role: text(args, 'role'), sessionId: options.sessionId, cwd: optional(args, 'cwd') ?? options.cwd,
        ...(saved ? { saved } : {}), ...(args.takeover === true ? { takeover: true } : {}), ...(args.steal === true ? { steal: true } : {}),
      });
      state.beatAt = now();
      return { ...result, saved: session.saved() };
    },
    leave: async () => (await session.leave()) ? true : false,
    disconnect: async () => (await session.disconnect()) ? true : false,
    send: async args => session.send(text(args, 'to'), kindOf(args.kind), text(args, 'body')),
    teammates: async () => session.teammates(),
    events: async () => session.events(),
    overview: async () => session.overview(),
    activity: async args => {
      const value = args.state === 'working' ? 'working' : 'idle';
      const focus = optional(args, 'focus');
      const activity: Activity = { state: value, since: new Date(now()).toISOString(), ...(focus ? { focus } : {}) };
      await session.setActivity(activity);
      return true;
    },
    renameTeam: async args => { await session.renameTeam(text(args, 'name')); return session.saved(); },
    renameMember: async args => { await session.renameMember(text(args, 'role'), text(args, 'name')); return session.saved(); },
    removeMember: async args => { await session.removeMember(text(args, 'role'), optional(args, 'teamId')); return true; },
    deleteTeam: async args => session.deleteTeam(optional(args, 'teamId')),
    assertAdmin: async () => { await session.assertAdmin(); return true; },
    assertRemovable: async args => { await session.assertRemovable(text(args, 'role'), optional(args, 'teamId')); return true; },
    assertDeletable: async args => { await session.assertDeletable(optional(args, 'teamId')); return true; },
  };

  const poll = async (): Promise<void> => {
    if (state.stopped || !session.current()) return;
    if (now() - state.beatAt >= (options.heartbeatMs ?? 5_000)) {
      state.beatAt = now();
      const beat = await session.heartbeat();
      if (beat.lost) {
        const fate = await session.fate(beat.lost.teamId, beat.lost.memberId, options.sessionId).catch((): Fate => ({ reason: 'replaced' }));
        options.emit({ type: 'lost', team: beat.lost.team, role: beat.lost.role, fate, text: lostText(beat.lost, fate) });
        return;
      }
      if (beat.renamed) options.emit({ type: 'renamed', ...beat.renamed });
    }
    const messages = await session.receive();
    if (messages.length) options.emit({ type: 'messages', messages });
  };

  const respond = (response: ServerResponse, status: number, body: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== 'POST' || request.url !== '/call') return respond(response, 404, { ok: false, error: 'Not found.' });
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const parsed = (() => { try { return JSON.parse(raw) as { op?: unknown; args?: unknown }; } catch { return undefined; } })();
    const op = typeof parsed?.op === 'string' ? ops[parsed.op] : undefined;
    if (!op) return respond(response, 400, { ok: false, error: 'Unknown op.' });
    const args = parsed?.args && typeof parsed.args === 'object' ? parsed.args as Args : {};
    if (state.stopped) return respond(response, 503, { ok: false, error: 'Team bridge is stopping.' });
    await queue(() => op(args)).then(
      value => respond(response, 200, { ok: true, value }),
      error => respond(response, 200, { ok: false, error: clean(error instanceof Error ? error.message : 'Team action failed.', 512), code: (error as { code?: string })?.code }),
    );
  };

  // macOS cuts a longer Unix socket path without an error, and clients then find nothing there.
  if (Buffer.byteLength(options.socket) > MAX_SOCKET_BYTES) throw new Error(`Socket path is ${Buffer.byteLength(options.socket)} bytes; Unix sockets allow ${MAX_SOCKET_BYTES}: ${options.socket}`);
  await ensurePrivateDirectory(dirname(options.socket));
  // A socket left by a bridge that crashed; anything else at that path is not ours to remove.
  const stale = await lstat(options.socket).catch(() => undefined);
  if (stale?.isSocket()) await unlink(options.socket);
  else if (stale) throw new Error(`Refusing to replace ${options.socket}: not a socket.`);
  const server: Server = createServer((request, response) => { void handle(request, response).catch(() => respond(response, 500, { ok: false, error: 'Bridge error.' })); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.socket, () => resolve()); });

  // One poll at a time: under load a slow poll must not pile up others ahead of the calls that share the queue.
  const timer = setInterval(() => {
    if (state.polling) return;
    state.polling = true;
    void queue(poll).catch(() => {}).finally(() => { state.polling = false; });
  }, options.pollMs ?? 1000);
  const stop = async (reason: string): Promise<void> => {
    if (state.stopped) return;
    state.stopped = true;
    clearInterval(timer);
    // Offline, never left: the role stays bound to the session, which takes it back when it starts again.
    await queue(() => session.disconnect()).catch(() => undefined);
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await unlink(options.socket).catch(() => {});
    options.emit({ type: 'stopped', reason });
    options.onStop?.(reason);
  };
  options.emit({ type: 'ready', protocol: BRIDGE_PROTOCOL, schemaVersion: SCHEMA_VERSION, socket: options.socket });
  return { stop };
}
