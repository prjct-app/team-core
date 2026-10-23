# team-core

The team transport shared by [pi-team](https://github.com/prjct-app/pi-team) (Pi) and the `team` mod for Claude Code. Terminals from either tool join the same team, see each other and exchange messages, because both write one on-disk format through this one implementation.

You do not install it by hand. `pi install npm:@prjct.app/pi-team` pulls it in as a dependency, and the Claude Code mod ships the bridge prebuilt.

Requires Node.js **22.23.4+**. Plain ESM JavaScript with type declarations, with no Pi and no Claude Code imports.

## What it holds

- **Storage**: teams, members, presence leases, per-member inboxes, delivery leases and receipts under `${PRJCT_HOME:-~/.prjct}/pi-team/`. Every record has strict schemas (`schemaVersion: 2`), byte limits and private permissions, and is written with locks and atomic writes.
- **`TeamSession`**: one terminal's place in a team. It covers join (with takeover of an offline role, or `steal` of one another terminal holds online: that terminal learns it was taken), leave, disconnect, heartbeat, send and receive (each message exactly once), activity, timeline, renames, removal and deletion.
- **`team-bridge`**: the same session served over a Unix socket for clients that cannot run Node in-process, such as a Claude Code mod.

## Use it as a library

```ts
import { TeamSession, TeamRuntime, TeamPaths } from '@prjct.app/team-core';

const session = new TeamSession(new TeamRuntime(new TeamPaths()));
await session.join({ team: 'shop', role: 'backend', sessionId: 'my-session', cwd: process.cwd() });
await session.send('reviewer', 'question', 'Is 401 right for a bad password?');
const incoming = await session.receive(); // [{ from, kind, body }]
```

Call `heartbeat()` about every 5 s to keep the member online, and `receive()` about every second. Run storage actions one at a time per session, as pi-team and the bridge do.

## Run the bridge

```sh
team-bridge serve --socket /path/to/private/dir/b.sock --session <session-id> --cwd <dir> [--root <dir>]
```

- **Calls**: `POST /call` with `{ "op": "...", "args": { ... } }` over the socket. The answer is `{ "ok": true, "value": ... }` or `{ "ok": false, "error": "...", "code"?: "..." }`. Errors never stop the bridge.
- **Events**: one JSON object per line on stdout:
  - `ready` (`protocol`, `schemaVersion`, `socket`)
  - `messages` (`[{ from, kind, body }]`, each delivered once)
  - `lost` (`team`, `role`, `fate`, `text`): removed, deleted or taken over
  - `renamed` (`team`, `role`)
  - `stopped`
- **Lifetime**: on SIGTERM, SIGINT or SIGHUP, or when its parent process exits, the bridge goes offline. It keeps the role, and the same `--session` rejoins it with `join { saved }`.

| Op | Args | Value |
| --- | --- | --- |
| `current` | | saved membership or `null` |
| `teams` | | `[{ id, name }]` |
| `plan` | `team`, `role`, `steal?` | `{ create, takeFrom?, online? }` |
| `join` | `team`, `role`, `saved?`, `takeover?`, `steal?`, `cwd?` | `{ created, saved }` |
| `leave` / `disconnect` | | `true` when a team was left |
| `send` | `to`, `kind` (`info`, `question`, `handoff`), `body` | `{ messageId, status: "submitted", ... }` |
| `teammates` / `events` / `overview` | | members with activity; the timeline; every team |
| `activity` | `state` (`working`, `idle`), `focus?` | `true` |
| `renameTeam` / `renameMember` | `name` / `role`, `name` | saved membership |
| `removeMember` / `deleteTeam` | `role`, `teamId?` / `teamId?` | `true` / the team name |
| `assertAdmin` / `assertRemovable` / `assertDeletable` | as above | `true`, or the reason it is not allowed |

The bridge speaks protocol `1`. A client should refuse a `ready` event with another `protocol` or `schemaVersion`.

## Compatibility

The format is the one pi-team has written since schema version 2. Pi terminals and bridge clients are ordinary members of the same team (`kind: "external"`). New kinds of data go in new files, never as new values inside existing records, so older clients keep reading the team.

## Development

```sh
npm ci
npm run check
npm test
npm run build
```

[MIT](LICENSE)
