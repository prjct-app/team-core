import { isAbsolute } from 'node:path';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { EntityIdSchema, TeamIdSchema, TimestampSchema, assertTeamId, timestampMillis, type Team } from './team.ts';

export type MemberKind = 'external' | 'supervised';
export type MemberState = 'active' | 'left';

export type Member = {
  readonly schemaVersion: 2;
  readonly teamId: string;
  readonly memberId: string;
  readonly sessionId?: string;
  readonly alias: string;
  readonly kind: MemberKind;
  readonly generation: number;
  readonly state: MemberState;
  readonly cwd: string;
  readonly joinedAt: string;
  readonly updatedAt: string;
  readonly leftAt?: string;
};

export const MemberSchema = Type.Object({
  schemaVersion: Type.Literal(2),
  teamId: TeamIdSchema,
  memberId: EntityIdSchema,
  sessionId: Type.Optional(EntityIdSchema),
  alias: TeamIdSchema,
  kind: Type.Union([Type.Literal('external'), Type.Literal('supervised')]),
  generation: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  state: Type.Union([Type.Literal('active'), Type.Literal('left')]),
  cwd: Type.String({ minLength: 1, maxLength: 4096 }),
  joinedAt: TimestampSchema,
  updatedAt: TimestampSchema,
  leftAt: Type.Optional(TimestampSchema),
}, { additionalProperties: false });

export function assertMember(value: unknown): asserts value is Member {
  if (!Value.Check(MemberSchema, value)) throw new Error('Invalid Team v2 member record.');
  const member = value as Member;
  assertTeamId(member.alias);
  if (member.cwd.includes('\0') || !isAbsolute(member.cwd)) throw new Error('Member cwd must be an absolute path without null bytes.');
  const joined = timestampMillis(member.joinedAt, 'member joinedAt');
  const updated = timestampMillis(member.updatedAt, 'member updatedAt');
  if (updated < joined) throw new Error('Member updatedAt precedes joinedAt.');
  if ((member.state === 'left') !== (member.leftAt !== undefined)) {
    throw new Error('Only a member in the left state has leftAt.');
  }
  if (member.leftAt !== undefined) {
    const left = timestampMillis(member.leftAt, 'member leftAt');
    if (left < joined || left > updated) throw new Error('Member leftAt falls outside its membership lifetime.');
  }
}

export function memberBelongsToTeam(member: Member, team: Pick<Team, 'teamId'>): void {
  if (member.teamId !== team.teamId) throw new Error('Member team ID does not match its team.');
}
