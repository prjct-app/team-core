import { createHash } from 'node:crypto';
import { leaseExpired, type Lease } from '../domain/lease.ts';
import { messageExpired, type Envelope, type ReceiptStatus } from '../domain/message.ts';
import { withStorageLock } from '../storage/atomic.ts';
import { InboxStore } from '../storage/inbox-store.ts';
import { LeaseStore } from '../storage/lease-store.ts';
import { ReceiptStore } from '../storage/receipt-store.ts';
import { MembershipService, type Membership } from './membership.ts';

export const DEFAULT_DELIVERY_LEASE_MS = 30_000;
const terminalReceipts = new Set<ReceiptStatus>(['replied', 'cancelled', 'expired', 'failed']);

export type DeliveryClaim = {
  readonly teamId: string;
  readonly memberId: string;
  readonly memberGeneration: number;
  readonly messageId: string;
  readonly token: string;
  readonly generation: number;
};

export type InboxItem = {
  readonly messageId: string;
  readonly threadId: string;
  readonly requestId?: string;
  readonly kind: Envelope['kind'];
  readonly fromMemberId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
};

export type ReconciledClaim = 'active' | 'released' | 'settled' | 'failed' | 'expired' | 'missing';

export class DeliveryService {
  private readonly leaseMs: number;
  private readonly now: () => number;

  constructor(
    private readonly memberships: MembershipService,
    private readonly inbox: InboxStore,
    private readonly receipts: ReceiptStore,
    private readonly leases: LeaseStore,
    options: { readonly leaseMs?: number; readonly now?: () => number } = {},
  ) {
    this.leaseMs = options.leaseMs ?? DEFAULT_DELIVERY_LEASE_MS;
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(this.leaseMs) || this.leaseMs <= 0) throw new Error('Invalid delivery lease duration.');
  }

  leaseId(messageId: string): string {
    return `delivery-${createHash('sha256').update(messageId).digest('hex')}`;
  }
  holderId(membership: Membership): string {
    return `member-${createHash('sha256').update(`${membership.memberId}:${membership.memberGeneration}`).digest('hex')}`;
  }
  private lockPath(teamId: string, messageId: string): string {
    return this.leases.paths.lock(`delivery-op-${createHash('sha256').update(`${teamId}\0${messageId}`).digest('hex')}`);
  }

  private claimFromLease(membership: Membership, messageId: string, lease: Lease): DeliveryClaim {
    return {
      teamId: membership.teamId,
      memberId: membership.memberId,
      memberGeneration: membership.memberGeneration,
      messageId,
      token: lease.token,
      generation: lease.generation,
    };
  }

  private async ownedLease(membership: Membership, messageId: string): Promise<Lease> {
    await this.memberships.assertOwner(membership);
    const lease = await this.leases.read(membership.teamId, this.leaseId(messageId));
    if (!lease || lease.kind !== 'delivery' || lease.resourceId !== messageId ||
        lease.holderId !== this.holderId(membership) || leaseExpired(lease, this.now())) {
      throw Object.assign(new Error('Delivery claim ownership has been fenced.'), { code: 'FENCED' });
    }
    return lease;
  }

  private async claimed(membership: Membership, messageId: string): Promise<Envelope> {
    const message = await this.inbox.readClaimed(membership.teamId, membership.memberId, messageId);
    if (!message) throw Object.assign(new Error(`Unknown claimed message "${messageId}".`), { code: 'NOT_FOUND' });
    return message;
  }

  private async releaseLease(membership: Membership, messageId: string, lease: Lease): Promise<void> {
    await this.leases.release(
      membership.teamId, this.leaseId(messageId), this.holderId(membership), lease.token, lease.generation,
    );
  }

  private async finishUnlocked(membership: Membership, messageId: string, lease: Lease): Promise<void> {
    await this.inbox.removeClaimed(membership.teamId, membership.memberId, messageId);
    await this.releaseLease(membership, messageId, lease).catch(() => {});
  }

  async inboxItems(membership: Membership, limit = 50, cursor?: string): Promise<{
    readonly items: readonly InboxItem[];
    readonly nextCursor?: string;
  }> {
    await this.memberships.assertOwner(membership);
    const page = await this.inbox.listPending(membership.teamId, membership.memberId, limit, cursor);
    return {
      items: page.messages.map(({ body: _body, senderGeneration: _sender, recipientGeneration: _recipient, teamId: _team, schemaVersion: _schema, toMemberId: _to, ...item }) => item),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  async claim(membership: Membership, messageId: string, signal?: AbortSignal): Promise<DeliveryClaim> {
    return withStorageLock(this.lockPath(membership.teamId, messageId), async () => {
      signal?.throwIfAborted();
      await this.memberships.assertOwner(membership);
      const message = await this.inbox.readPending(membership.teamId, membership.memberId, messageId);
      if (!message) throw Object.assign(new Error(`Unknown pending message "${messageId}".`), { code: 'NOT_FOUND' });
      const receipt = await this.receipts.read(membership.teamId, membership.memberId, messageId);
      if (receipt && terminalReceipts.has(receipt.status)) {
        await this.inbox.removePending(membership.teamId, membership.memberId, messageId);
        throw Object.assign(new Error(`Message is already ${receipt.status}.`), { code: 'TERMINAL_MESSAGE' });
      }
      const sender = await this.memberships.member(message.teamId, message.fromMemberId);
      const recipientFenced = message.recipientGeneration !== undefined &&
        message.recipientGeneration !== membership.memberGeneration;
      const senderFenced = message.kind !== 'cancel' &&
        (!sender || sender.generation !== message.senderGeneration ||
          (message.kind === 'request' && sender.state !== 'active'));
      if (recipientFenced || senderFenced) {
        await this.receipts.record({
          schemaVersion: 2,
          teamId: membership.teamId,
          messageId,
          recipientId: membership.memberId,
          status: 'failed',
          at: new Date(this.now()).toISOString(),
        });
        await this.inbox.removePending(membership.teamId, membership.memberId, messageId);
        throw Object.assign(new Error('Message ownership generation has been fenced.'), { code: 'FENCED' });
      }
      signal?.throwIfAborted();
      const lease = await this.leases.acquire({
        teamId: membership.teamId,
        leaseId: this.leaseId(messageId),
        kind: 'delivery',
        holderId: this.holderId(membership),
        resourceId: messageId,
        ttlMs: this.leaseMs,
      });
      try {
        signal?.throwIfAborted();
        await this.inbox.claim(membership.teamId, membership.memberId, messageId);
        return this.claimFromLease(membership, messageId, lease);
      } catch (error) {
        await this.releaseLease(membership, messageId, lease).catch(() => {});
        throw error;
      }
    });
  }

  async read(membership: Membership, messageId: string, signal?: AbortSignal): Promise<Envelope> {
    return withStorageLock(this.lockPath(membership.teamId, messageId), async () => {
      signal?.throwIfAborted();
      const lease = await this.ownedLease(membership, messageId);
      const message = await this.claimed(membership, messageId);
      const receipt = await this.receipts.read(membership.teamId, membership.memberId, messageId);
      if (messageExpired(message, this.now())) {
        if (!receipt) {
          await this.receipts.record({
            schemaVersion: 2,
            teamId: membership.teamId,
            messageId,
            recipientId: membership.memberId,
            status: 'expired',
            at: new Date(this.now()).toISOString(),
          });
        } else if (!terminalReceipts.has(receipt.status)) {
          await this.receipts.record({ ...receipt, status: 'expired', at: new Date(this.now()).toISOString() });
        }
        await this.finishUnlocked(membership, messageId, lease);
        throw Object.assign(new Error('Message has expired.'), { code: 'EXPIRED' });
      }
      if (receipt && terminalReceipts.has(receipt.status)) {
        throw Object.assign(new Error(`Message is already ${receipt.status}.`), { code: 'TERMINAL_MESSAGE' });
      }
      if (message.kind === 'reply' && message.requestId) {
        const original = await this.receipts.read(membership.teamId, message.fromMemberId, message.requestId);
        if (!original || !terminalReceipts.has(original.status)) {
          throw Object.assign(new Error('Reply outcome is not durable yet.'), { code: 'NOT_READY' });
        }
      }
      signal?.throwIfAborted();
      const timestamp = new Date(this.now()).toISOString();
      if (!receipt) {
        await this.receipts.record({
          schemaVersion: 2,
          teamId: membership.teamId,
          messageId,
          recipientId: membership.memberId,
          status: 'delivered',
          at: timestamp,
        });
      }
      const delivered = receipt ?? await this.receipts.read(membership.teamId, membership.memberId, messageId);
      if (delivered?.status === 'delivered') {
        await this.receipts.record({ ...delivered, status: 'read', at: timestamp });
      }
      return message;
    });
  }

  async renew(membership: Membership, messageId: string): Promise<DeliveryClaim> {
    return withStorageLock(this.lockPath(membership.teamId, messageId), async () => {
      const lease = await this.ownedLease(membership, messageId);
      const renewed = await this.leases.renew(
        membership.teamId,
        lease.leaseId,
        this.holderId(membership),
        lease.token,
        lease.generation,
        this.leaseMs,
      );
      return this.claimFromLease(membership, messageId, renewed);
    });
  }

  async release(membership: Membership, messageId: string): Promise<void> {
    await withStorageLock(this.lockPath(membership.teamId, messageId), async () => {
      const lease = await this.ownedLease(membership, messageId);
      const receipt = await this.receipts.read(membership.teamId, membership.memberId, messageId);
      if (receipt) throw new Error('A delivered message cannot be released for reinjection.');
      await this.inbox.release(membership.teamId, membership.memberId, messageId);
      await this.releaseLease(membership, messageId, lease);
    });
  }

  async finish(membership: Membership, messageId: string): Promise<void> {
    await withStorageLock(this.lockPath(membership.teamId, messageId), async () => {
      const lease = await this.ownedLease(membership, messageId);
      await this.finishUnlocked(membership, messageId, lease);
    });
  }

  async settle<T>(
    membership: Membership,
    messageId: string,
    operation: (message: Envelope) => Promise<T>,
  ): Promise<T> {
    return withStorageLock(this.lockPath(membership.teamId, messageId), async () => {
      const lease = await this.ownedLease(membership, messageId);
      const message = await this.claimed(membership, messageId);
      const result = await operation(message);
      await this.finishUnlocked(membership, messageId, lease);
      return result;
    });
  }

  async fail(membership: Membership, messageId: string): Promise<void> {
    await withStorageLock(this.lockPath(membership.teamId, messageId), async () => {
      const lease = await this.ownedLease(membership, messageId);
      const receipt = await this.receipts.read(membership.teamId, membership.memberId, messageId);
      if (receipt && !terminalReceipts.has(receipt.status)) {
        await this.receipts.record({ ...receipt, status: 'failed', at: new Date(this.now()).toISOString() });
      }
      await this.finishUnlocked(membership, messageId, lease);
    });
  }

  async reconcileClaim(teamId: string, recipientId: string, messageId: string): Promise<ReconciledClaim> {
    return withStorageLock(this.lockPath(teamId, messageId), async () => {
      const message = await this.inbox.readClaimed(teamId, recipientId, messageId);
      if (!message) return 'missing';
      const lease = await this.leases.read(teamId, this.leaseId(messageId));
      const receipt = await this.receipts.read(teamId, recipientId, messageId);
      const expired = messageExpired(message, this.now());
      if (!expired && lease && !leaseExpired(lease, this.now()) &&
          (!receipt || !terminalReceipts.has(receipt.status))) return 'active';
      if (expired) {
        if (!receipt) {
          await this.receipts.record({
            schemaVersion: 2,
            teamId,
            messageId,
            recipientId,
            status: 'expired',
            at: new Date(this.now()).toISOString(),
          });
        } else if (!terminalReceipts.has(receipt.status)) {
          await this.receipts.record({ ...receipt, status: 'expired', at: new Date(this.now()).toISOString() });
        }
        await this.inbox.removeClaimed(teamId, recipientId, messageId);
        if (lease) await this.leases.release(teamId, lease.leaseId, lease.holderId, lease.token, lease.generation).catch(() => {});
        return 'expired';
      }
      if (receipt) {
        const terminal = terminalReceipts.has(receipt.status);
        if (!terminal) {
          await this.receipts.record({ ...receipt, status: 'failed', at: new Date(this.now()).toISOString() });
        }
        await this.inbox.removeClaimed(teamId, recipientId, messageId);
        if (lease) await this.leases.release(teamId, lease.leaseId, lease.holderId, lease.token, lease.generation).catch(() => {});
        return terminal ? 'settled' : 'failed';
      }
      await this.inbox.release(teamId, recipientId, messageId);
      return 'released';
    });
  }

  async deliverNextRequest(
    membership: Membership,
    humanEnabled: boolean,
    inject: (message: Envelope) => Promise<void>,
  ): Promise<Envelope | undefined> {
    if (!humanEnabled || membership.kind !== 'supervised') return undefined;
    const page = await this.inbox.listPending(membership.teamId, membership.memberId, 100);
    const message = page.messages.find(candidate => candidate.kind === 'request');
    if (!message) return undefined;
    await this.claim(membership, message.messageId);
    const delivered = await this.read(membership, message.messageId);
    try {
      await inject(delivered);
      return delivered;
    } catch (error) {
      await this.fail(membership, message.messageId);
      throw error;
    }
  }
}
