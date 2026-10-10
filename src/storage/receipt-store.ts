import { assertReceipt, type Receipt, type ReceiptStatus } from '../domain/message.ts';
import { assertEntityId, assertTeamId, timestampMillis } from '../domain/team.ts';
import {
  createAtomicJson, ensurePrivateDirectory, ensurePrivateTree, jsonFileNames, readJson, removeAtomic, replaceAtomicJson,
  withStorageLock,
} from './atomic.ts';
import { TeamPaths } from './paths.ts';

const RECEIPT_MAX_BYTES = 16 * 1024;
const TERMINAL_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const terminal = new Set<ReceiptStatus>(['replied', 'cancelled', 'expired', 'failed']);
const transitions: Readonly<Record<ReceiptStatus, readonly ReceiptStatus[]>> = {
  delivered: ['read', 'replied', 'cancelled', 'expired', 'failed'],
  read: ['replied', 'cancelled', 'expired', 'failed'],
  replied: [],
  cancelled: [],
  expired: [],
  failed: [],
};

export type ReceiptStoreOptions = {
  readonly terminalTtlMs?: number;
  readonly now?: () => number;
};

export class ReceiptStore {
  private readonly terminalTtlMs: number;
  private readonly now: () => number;

  constructor(readonly paths: TeamPaths, options: ReceiptStoreOptions = {}) {
    this.terminalTtlMs = options.terminalTtlMs ?? TERMINAL_RECEIPT_TTL_MS;
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(this.terminalTtlMs) || this.terminalTtlMs <= 0) throw new Error('Invalid receipt TTL.');
  }

  private lockPath(teamId: string): string { return this.paths.lock(`receipts-${assertTeamId(teamId)}`); }

  private async prepare(): Promise<void> {
    await ensurePrivateTree(this.paths.root, 'teams');
    await ensurePrivateTree(this.paths.root, 'control');
  }

  private async prepareRecipient(teamId: string, recipientId: string, create: boolean): Promise<boolean> {
    try {
      await ensurePrivateDirectory(this.paths.team(teamId), false);
      await ensurePrivateDirectory(this.paths.receipts(teamId), false);
      await ensurePrivateDirectory(this.paths.recipientReceipts(teamId, recipientId), create);
      return true;
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private assertStoredReceipt(receipt: Receipt, teamId: string, recipientId: string, messageId: string): void {
    if (receipt.teamId !== teamId || receipt.recipientId !== recipientId || receipt.messageId !== messageId) {
      throw Object.assign(new Error('Receipt identity does not match its storage path.'), { code: 'CORRUPT_RECORD' });
    }
  }

  async read(teamId: string, recipientId: string, messageId: string): Promise<Receipt | undefined> {
    await this.prepare();
    if (!await this.prepareRecipient(teamId, recipientId, false)) return undefined;
    const receipt = await readJson(this.paths.receipt(teamId, recipientId, messageId), assertReceipt, RECEIPT_MAX_BYTES);
    if (receipt) this.assertStoredReceipt(receipt, teamId, recipientId, messageId);
    return receipt;
  }

  async record(receipt: Receipt): Promise<void> {
    assertReceipt(receipt);
    await this.prepare();
    await withStorageLock(this.lockPath(receipt.teamId), async () => {
      await this.prepareRecipient(receipt.teamId, receipt.recipientId, true);
      const path = this.paths.receipt(receipt.teamId, receipt.recipientId, receipt.messageId);
      const current = await readJson(path, assertReceipt, RECEIPT_MAX_BYTES);
      if (!current) {
        await createAtomicJson(path, receipt, RECEIPT_MAX_BYTES);
        return;
      }
      this.assertStoredReceipt(current, receipt.teamId, receipt.recipientId, receipt.messageId);
      if (current.status === receipt.status) return;
      if (!transitions[current.status].includes(receipt.status)) {
        throw Object.assign(new Error(`Invalid receipt transition: ${current.status} → ${receipt.status}.`), { code: 'INVALID_TRANSITION' });
      }
      if (timestampMillis(receipt.at, 'receipt timestamp') < timestampMillis(current.at, 'receipt timestamp')) {
        throw new Error('Receipt timestamp moved backwards.');
      }
      await replaceAtomicJson(path, receipt, { maxBytes: RECEIPT_MAX_BYTES });
    });
  }

  async list(teamId: string, recipientId: string, limit = 100, cursor?: string): Promise<readonly Receipt[]> {
    assertTeamId(teamId);
    assertEntityId(recipientId, 'recipient ID');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Receipt page limit must be between 1 and 100.');
    if (cursor !== undefined) assertEntityId(cursor, 'receipt cursor');
    await this.prepare();
    if (!await this.prepareRecipient(teamId, recipientId, false)) return [];
    const ids = await jsonFileNames(this.paths.recipientReceipts(teamId, recipientId), false);
    const page = (cursor === undefined ? ids : ids.filter(id => id > cursor)).slice(0, limit);
    const records = await Promise.all(page.map(id => this.read(teamId, recipientId, id)));
    return records.filter((receipt): receipt is Receipt => receipt !== undefined);
  }

  async purgeExpired(teamId: string, recipientId: string): Promise<number> {
    await this.prepare();
    return withStorageLock(this.lockPath(teamId), async () => {
      if (!await this.prepareRecipient(teamId, recipientId, false)) return 0;
      const ids = await jsonFileNames(this.paths.recipientReceipts(teamId, recipientId), false);
      const receipts = await Promise.all(ids.map(id => this.read(teamId, recipientId, id)));
      const expired = receipts.filter((receipt): receipt is Receipt => receipt !== undefined && terminal.has(receipt.status) &&
        this.now() - timestampMillis(receipt.at, 'receipt timestamp') >= this.terminalTtlMs);
      await Promise.all(expired.map(receipt => removeAtomic(this.paths.receipt(teamId, recipientId, receipt.messageId))));
      return expired.length;
    });
  }
}
