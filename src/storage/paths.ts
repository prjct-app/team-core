import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { assertEntityId, assertTeamId } from '../domain/team.ts';

export type LegacyDetection = {
  readonly path: string;
  readonly present: boolean;
  readonly kind: 'directory' | 'symlink' | 'other' | 'absent';
};

export function defaultStorageRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const projectHome = environment.PRJCT_HOME?.trim();
  const base = projectHome ? (isAbsolute(projectHome) ? projectHome : resolve(projectHome)) : join(homedir(), '.prjct');
  return join(base, 'pi-team');
}

export async function detectLegacyRoot(path = join(homedir(), '.pi', 'agent', 'teams')): Promise<LegacyDetection> {
  const info = await lstat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!info) return { path, present: false, kind: 'absent' };
  return {
    path,
    present: true,
    kind: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'other',
  };
}

export class TeamPaths {
  readonly root: string;

  constructor(root = defaultStorageRoot()) {
    this.root = resolve(root);
  }

  teams(): string { return join(this.root, 'teams'); }
  control(): string { return join(this.root, 'control'); }
  team(teamId: string): string { return join(this.teams(), assertTeamId(teamId)); }
  teamRecord(teamId: string): string { return join(this.team(teamId), 'team.json'); }
  members(teamId: string): string { return join(this.team(teamId), 'members'); }
  member(teamId: string, memberId: string): string {
    return join(this.members(teamId), `${assertEntityId(memberId, 'member ID')}.json`);
  }
  runtimes(teamId: string): string { return join(this.team(teamId), 'runtimes'); }
  runtime(teamId: string, runtimeId: string): string {
    return join(this.runtimes(teamId), `${assertEntityId(runtimeId, 'runtime ID')}.json`);
  }
  inbox(teamId: string): string { return join(this.team(teamId), 'inbox'); }
  memberInbox(teamId: string, memberId: string): string {
    return join(this.inbox(teamId), assertEntityId(memberId, 'member ID'));
  }
  pending(teamId: string, memberId: string): string { return join(this.memberInbox(teamId, memberId), 'pending'); }
  claimed(teamId: string, memberId: string): string { return join(this.memberInbox(teamId, memberId), 'claimed'); }
  pendingMessage(teamId: string, memberId: string, messageId: string): string {
    return join(this.pending(teamId, memberId), `${assertEntityId(messageId, 'message ID')}.json`);
  }
  claimedMessage(teamId: string, memberId: string, messageId: string): string {
    return join(this.claimed(teamId, memberId), `${assertEntityId(messageId, 'message ID')}.json`);
  }
  receipts(teamId: string): string { return join(this.team(teamId), 'receipts'); }
  recipientReceipts(teamId: string, recipientId: string): string {
    return join(this.receipts(teamId), assertEntityId(recipientId, 'recipient ID'));
  }
  receipt(teamId: string, recipientId: string, messageId: string): string {
    return join(this.recipientReceipts(teamId, recipientId), `${assertEntityId(messageId, 'message ID')}.json`);
  }
  leases(teamId: string): string { return join(this.team(teamId), 'leases'); }
  lease(teamId: string, leaseId: string): string {
    return join(this.leases(teamId), `${assertEntityId(leaseId, 'lease ID')}.json`);
  }
  lock(name: string): string { return join(this.control(), `${assertEntityId(name, 'lock ID')}.lock`); }
  teamLock(teamId: string): string { return this.lock(`team-${assertTeamId(teamId)}`); }
  inboxLock(teamId: string): string { return this.lock(`inbox-${assertTeamId(teamId)}`); }
}
