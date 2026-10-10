import { messageExpired, type Envelope } from '../domain/message.ts';
import { withStorageLock } from '../storage/atomic.ts';
import { InboxStore, type InboxPage } from '../storage/inbox-store.ts';
import { TeamPaths } from '../storage/paths.ts';
import { ReceiptStore } from '../storage/receipt-store.ts';
import { TeamStore } from '../storage/team-store.ts';
import { DeliveryService } from './delivery.ts';
import { PresenceService } from './presence.ts';
import { RequestService } from './requests.ts';

export type ReconcileResult = {
  readonly offlineMembers: number;
  readonly releasedClaims: number;
  readonly failedClaims: number;
  readonly expiredMessages: number;
  readonly expiredReceipts: number;
};

export class TeamReconciler {
  private readonly now: () => number;

  constructor(
    private readonly paths: TeamPaths,
    private readonly teams: TeamStore,
    private readonly inbox: InboxStore,
    private readonly receipts: ReceiptStore,
    private readonly presence: PresenceService,
    private readonly delivery: DeliveryService,
    private readonly requests: RequestService,
    now: () => number = Date.now,
  ) {
    this.now = now;
  }

  private async pageAll(load: (cursor?: string) => Promise<InboxPage>, cursor?: string): Promise<readonly Envelope[]> {
    const page = await load(cursor);
    return page.nextCursor
      ? [...page.messages, ...await this.pageAll(load, page.nextCursor)]
      : page.messages;
  }

  async reconcile(teamId: string): Promise<ReconcileResult> {
    return withStorageLock(this.paths.lock(`membership-${teamId}`), async () => {
      const members = await this.teams.listMembers(teamId);
      const staleMembers = (await Promise.all(members.map(async member =>
        member.state === 'active' && !await this.presence.online(member) ? member : undefined)))
        .filter((member): member is NonNullable<typeof member> => member !== undefined);
      const timestamp = new Date(this.now()).toISOString();
      await Promise.all(staleMembers.map(member => this.teams.updateMember(teamId, member.memberId, member.generation, current => ({
        ...current,
        state: 'left',
        leftAt: timestamp,
        updatedAt: timestamp,
      }))));

      const claimedByMember = await Promise.all(members.map(async member => ({
        member,
        messages: await this.pageAll(cursor => this.inbox.listClaimed(teamId, member.memberId, 100, cursor)),
      })));
      const claimed = claimedByMember.flatMap(entry => entry.messages.map(message => ({ member: entry.member, message })));
      const pendingByMember = await Promise.all(members.map(async member => ({
        member,
        messages: await this.pageAll(cursor => this.inbox.listPending(teamId, member.memberId, 100, cursor)),
      })));
      const pending = pendingByMember.flatMap(entry => entry.messages);
      const staleOwners = new Set(staleMembers.map(member => `${member.memberId}:${member.generation}`));
      const staleRequests = [...claimed.map(entry => entry.message), ...pending]
        .filter(message => message.kind === 'request' && staleOwners.has(`${message.fromMemberId}:${message.senderGeneration}`));
      await Promise.all(staleRequests.map(message => this.requests.cancelAbandoned(message)));
      await Promise.all([
        ...claimed.map(async entry => {
          if (entry.message.kind === 'request') await this.requests.repairCancellation(entry.message, 'claimed');
          if (entry.message.kind === 'reply') await this.requests.repairReplyOutcome(entry.message);
        }),
        ...pending.map(async message => {
          if (message.kind === 'request') await this.requests.repairCancellation(message, 'pending');
          if (message.kind === 'reply') await this.requests.repairReplyOutcome(message);
        }),
      ]);
      const settled = await Promise.all(claimed.map(entry =>
        this.delivery.reconcileClaim(teamId, entry.member.memberId, entry.message.messageId)));
      const expired = pendingByMember.flatMap(entry => entry.messages
        .filter(message => messageExpired(message, this.now()))
        .map(message => ({ member: entry.member, message })));
      await Promise.all(expired.map(async entry => {
        if (entry.message.kind === 'request') {
          const receipt = await this.receipts.read(teamId, entry.member.memberId, entry.message.messageId);
          if (!receipt) {
            await this.receipts.record({
              schemaVersion: 2,
              teamId,
              messageId: entry.message.messageId,
              recipientId: entry.member.memberId,
              status: 'expired',
              at: timestamp,
            });
          }
        }
        await this.inbox.removePending(teamId, entry.member.memberId, entry.message.messageId);
      }));
      const expiredReceipts = (await Promise.all(members.map(member =>
        this.receipts.purgeExpired(teamId, member.memberId)))).reduce((sum, count) => sum + count, 0);
      return {
        offlineMembers: staleMembers.length,
        releasedClaims: settled.filter(result => result === 'released').length,
        failedClaims: settled.filter(result => result === 'failed').length,
        expiredMessages: expired.length + settled.filter(result => result === 'expired').length,
        expiredReceipts,
      };
    });
  }
}
