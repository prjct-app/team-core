import { Type } from 'typebox';
import { Value } from 'typebox/value';

export const TEAM_ID_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;
export const ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const TeamIdSchema = Type.String({ pattern: TEAM_ID_PATTERN.source });
export const EntityIdSchema = Type.String({ pattern: ENTITY_ID_PATTERN.source });
export const TimestampSchema = Type.String({ pattern: ISO_TIMESTAMP_PATTERN.source });

export type TeamState = 'open' | 'closing' | 'closing_blocked' | 'closed';

const transitions: Readonly<Record<TeamState, readonly TeamState[]>> = {
  open: ['closing'],
  closing: ['closing_blocked', 'closed'],
  closing_blocked: ['closing', 'closed'],
  closed: [],
};

export type Team = {
  readonly schemaVersion: 2;
  readonly teamId: string;
  readonly state: TeamState;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export const TeamSchema = Type.Object({
  schemaVersion: Type.Literal(2),
  teamId: TeamIdSchema,
  state: Type.Union([
    Type.Literal('open'),
    Type.Literal('closing'),
    Type.Literal('closing_blocked'),
    Type.Literal('closed'),
  ]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}, { additionalProperties: false });

export function assertTeamId(value: string): string {
  if (!TEAM_ID_PATTERN.test(value)) {
    throw new Error('Invalid team ID. Use 1–48 lowercase letters, digits, or hyphens, starting with a letter.');
  }
  return value;
}

export function assertEntityId(value: string, label = 'entity ID'): string {
  if (!ENTITY_ID_PATTERN.test(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

export function timestampMillis(value: string, label = 'timestamp'): number {
  if (!ISO_TIMESTAMP_PATTERN.test(value)) throw new Error(`Invalid ${label}.`);
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) throw new Error(`Invalid ${label}.`);
  return millis;
}

export function assertTeam(value: unknown): asserts value is Team {
  if (!Value.Check(TeamSchema, value)) throw new Error('Invalid Team v2 record.');
  const team = value as Team;
  if (timestampMillis(team.updatedAt, 'team updatedAt') < timestampMillis(team.createdAt, 'team createdAt')) {
    throw new Error('Team updatedAt precedes createdAt.');
  }
}

export function assertTeamTransition(from: TeamState, to: TeamState): void {
  if (from !== to && !transitions[from].includes(to)) throw new Error(`Invalid team transition: ${from} → ${to}.`);
}
