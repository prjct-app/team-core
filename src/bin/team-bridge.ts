#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { BRIDGE_PROTOCOL, startBridge, type BridgeEvent } from '../bridge.ts';

const USAGE = `team-bridge serve --socket <path> --session <id> --cwd <dir> [--root <dir>]

Serves one client session's place in a team over a Unix socket (POST /call
{ op, args }) and writes events to stdout as JSON lines. Speaks protocol ${BRIDGE_PROTOCOL}.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    socket: { type: 'string' }, session: { type: 'string' }, cwd: { type: 'string' }, root: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help || positionals[0] !== 'serve' || !values.socket || !values.session) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(values.help ? 0 : 2);
}

const emit = (event: BridgeEvent): void => { process.stdout.write(`${JSON.stringify(event)}\n`); };
const bridge = await startBridge({
  socket: values.socket, sessionId: values.session, cwd: values.cwd ?? process.cwd(),
  ...(values.root ? { root: values.root } : {}),
  emit, onStop: () => process.exit(0),
}).catch(error => {
  process.stderr.write(`team-bridge: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

// The client owns this process: when it is gone, go offline and exit instead of holding the role.
const parent = process.ppid;
const watch = setInterval(() => { if (process.ppid !== parent) void bridge.stop('client exited'); }, 2000);
watch.unref();
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(signal, () => { void bridge.stop(signal); });
