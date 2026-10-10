/**
 * The team transport every client shares: Pi through pi-team, Claude Code
 * through the team mod's bridge. One implementation of the on-disk format,
 * its locks and its schemas, so clients never drift apart.
 */
export { TeamRuntime } from './runtime/team-runtime.ts';
export { TeamPaths, defaultStorageRoot } from './storage/paths.ts';
export {
  TeamSession, MESSAGE_KINDS, NAME_PATTERN, EVENT_TYPES, MAX_BODY_BYTES, assertName,
  type Activity, type EventType, type Fate, type Incoming, type Joined, type JoinPlan, type MessageKind,
  type Saved, type SendReceipt, type TeamEvent, type TeamOverview, type Teammate,
} from './session.ts';
export { TEAM_ID_PATTERN } from './domain/team.ts';
export { ago, bounded, clean } from './text.ts';
