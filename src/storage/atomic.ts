import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';

export const DEFAULT_MAX_RECORD_BYTES = 256 * 1024;
const LOCK_ATTEMPTS = Array.from({ length: 200 }, (_, index) => index);

export type RecordValidator<T> = (value: unknown) => asserts value is T;
export type AtomicWriteOptions = {
  readonly maxBytes?: number;
  readonly previous?: boolean;
};
export type LockOptions = {
  readonly staleMs?: number;
  readonly retryMs?: number;
};

function storageError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function assertPrivateMode(path: string, info: { mode: number; uid: number }): void {
  if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
    throw storageError(`Unsafe storage permissions or owner: ${path}.`, 'UNSAFE_STORAGE');
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncCreatedDirectories(firstCreated: string, target: string): Promise<void> {
  const suffix = relative(firstCreated, target).split(sep).filter(Boolean);
  const created = [firstCreated, ...suffix.map((_, index) => join(firstCreated, ...suffix.slice(0, index + 1)))];
  for (const path of created) await syncDirectory(dirname(path));
}

// mkdir is not a durable publication by itself. Sync every parent that gained
// a directory entry, from the first recursively created component to the leaf.
async function createDirectories(path: string, mode: number): Promise<void> {
  const firstCreated = await mkdir(path, { recursive: true, mode });
  if (firstCreated) await syncCreatedDirectories(firstCreated, path);
}

export async function ensurePrivateDirectory(path: string, create = true): Promise<void> {
  if (create) await createDirectories(path, 0o700);
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw storageError(`Unsafe storage directory: ${path}.`, 'UNSAFE_STORAGE');
  }
  assertPrivateMode(path, info);
}

async function nearestExistingDirectory(path: string): Promise<string> {
  const info = await lstat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (info) {
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw storageError(`Unsafe storage ancestor: ${path}.`, 'UNSAFE_STORAGE');
    }
    return path;
  }
  const parent = dirname(path);
  if (parent === path) throw storageError(`No existing storage ancestor for ${path}.`, 'UNSAFE_STORAGE');
  return nearestExistingDirectory(parent);
}

async function ensureRootParent(root: string): Promise<void> {
  const parent = dirname(root);
  const existing = await nearestExistingDirectory(parent);
  await createDirectories(parent, 0o700);
  const suffix = relative(existing, parent).split(sep).filter(Boolean);
  const chain = [existing, ...suffix.map((_, index) => join(existing, ...suffix.slice(0, index + 1)))];
  for (const path of chain) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw storageError(`Unsafe storage ancestor: ${path}.`, 'UNSAFE_STORAGE');
    }
  }
}

export async function ensurePrivateTree(root: string, ...segments: readonly string[]): Promise<void> {
  await ensureRootParent(root);
  await ensurePrivateDirectory(root);
  const paths = segments.map((_, index) => join(root, ...segments.slice(0, index + 1)));
  for (const path of paths) await ensurePrivateDirectory(path);
}

function checkSize(text: string, maxBytes: number): void {
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw storageError(`Record exceeds ${maxBytes} bytes.`, 'RECORD_TOO_LARGE');
  }
}

async function readText(path: string, maxBytes: number): Promise<string | undefined> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!handle) return undefined;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw storageError(`Unsafe storage file: ${path}.`, 'UNSAFE_STORAGE');
    assertPrivateMode(path, info);
    if (info.size > maxBytes) throw storageError(`Record exceeds ${maxBytes} bytes.`, 'RECORD_TOO_LARGE');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

export async function readJson<T>(path: string, validate: RecordValidator<T>, maxBytes = DEFAULT_MAX_RECORD_BYTES): Promise<T | undefined> {
  const text = await readText(path, maxBytes);
  if (text === undefined) return undefined;
  const parsed = (() => {
    try { return JSON.parse(text) as unknown; }
    catch { throw storageError(`Corrupt JSON record preserved at ${path}.`, 'CORRUPT_RECORD'); }
  })();
  try { validate(parsed); }
  catch (error) {
    throw Object.assign(new Error(`Invalid record preserved at ${path}: ${(error as Error).message}`), { code: 'CORRUPT_RECORD' });
  }
  return parsed;
}

async function writeTemporary(path: string, text: string, maxBytes: number): Promise<string> {
  checkSize(text, maxBytes);
  await ensurePrivateDirectory(dirname(path));
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await handle.close();
  return temporary;
}

export async function createAtomicJson(path: string, value: unknown, maxBytes = DEFAULT_MAX_RECORD_BYTES): Promise<void> {
  const temporary = await writeTemporary(path, `${JSON.stringify(value)}\n`, maxBytes);
  try {
    await link(temporary, path);
    await syncDirectory(dirname(path));
  } finally { await unlink(temporary).catch(() => {}); }
}

export async function replaceAtomicJson(path: string, value: unknown, options: AtomicWriteOptions = {}): Promise<void> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_RECORD_BYTES;
  const text = `${JSON.stringify(value)}\n`;
  checkSize(text, maxBytes);
  if (options.previous) {
    const current = await readText(path, maxBytes);
    if (current !== undefined) await replaceAtomicText(`${path}.previous`, current, maxBytes);
  }
  await replaceAtomicText(path, text, maxBytes);
}

async function replaceAtomicText(path: string, text: string, maxBytes: number): Promise<void> {
  const temporary = await writeTemporary(path, text, maxBytes);
  try {
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function moveAtomic(from: string, to: string): Promise<void> {
  await ensurePrivateDirectory(dirname(to));
  await rename(from, to);
  await syncDirectory(dirname(to));
  if (dirname(from) !== dirname(to)) await syncDirectory(dirname(from));
}

export async function removeAtomic(path: string): Promise<boolean> {
  const removed = await unlink(path).then(() => true, error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  });
  if (removed) await syncDirectory(dirname(path));
  return removed;
}

export async function jsonFileNames(path: string, create = true): Promise<string[]> {
  try { await ensurePrivateDirectory(path, create); }
  catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const entries = await readdir(path, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && !entry.isSymbolicLink() && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(entry.name))
    .map(entry => entry.name.slice(0, -'.json'.length))
    .sort();
}

async function processAlive(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

async function staleLock(path: string, staleMs: number): Promise<boolean> {
  const info = await lstat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!info) return false;
  if (!info.isFile() || info.isSymbolicLink()) throw storageError(`Unsafe lock file: ${path}.`, 'UNSAFE_STORAGE');
  assertPrivateMode(path, info);
  if (Date.now() - info.mtimeMs <= staleMs) return false;
  const text = await readText(path, 4096);
  const pid = (() => {
    try {
      const parsed = JSON.parse(text ?? '') as { pid?: unknown };
      return typeof parsed.pid === 'number' && Number.isSafeInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : undefined;
    } catch { return undefined; }
  })();
  return pid === undefined || !await processAlive(pid);
}

async function tryAcquireLock(path: string): Promise<{ readonly handle: Awaited<ReturnType<typeof open>>; readonly token: string } | undefined> {
  const token = randomUUID();
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    .catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
      throw error;
    });
  if (!handle) return undefined;
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }), 'utf8');
    return { handle, token };
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(path).catch(() => {});
    throw error;
  }
}

async function releaseLock(path: string, token: string): Promise<void> {
  const text = await readText(path, 4096).catch(() => undefined);
  const currentToken = (() => {
    try { return (JSON.parse(text ?? '') as { token?: unknown }).token; }
    catch { return undefined; }
  })();
  if (currentToken === token) await unlink(path).catch(() => {});
}

type GateResult<T> = { readonly entered: false } | { readonly entered: true; readonly value: T };

// Main-lock replacement and release run only while this short-lived gate is
// owned. Stale gates are reclaimed only for dead holders and only while their
// inode still matches the inspected handle; a changed pathname is left alone.
async function reclaimStaleGate(path: string, staleMs: number): Promise<boolean> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!handle) return false;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw storageError(`Unsafe lock gate: ${path}.`, 'UNSAFE_STORAGE');
    assertPrivateMode(path, info);
    if (Date.now() - info.mtimeMs <= staleMs) return false;
    const text = await handle.readFile('utf8');
    const parsed = (() => {
      try { return JSON.parse(text) as { pid?: unknown }; }
      catch { return {} as { pid?: unknown }; }
    })();
    const pid = typeof parsed.pid === 'number' && Number.isSafeInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : undefined;
    if (pid !== undefined && await processAlive(pid)) return false;
    const current = await lstat(path).catch(() => undefined);
    if (!current || current.dev !== info.dev || current.ino !== info.ino) return false;
    await unlink(path);
    return true;
  } finally { await handle.close(); }
}

async function underLockGate<T>(path: string, staleMs: number, action: () => Promise<T>): Promise<GateResult<T>> {
  const gatePath = `${path}.gate`;
  const token = randomUUID();
  const gate = await open(
    gatePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  ).catch(async error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    await reclaimStaleGate(gatePath, staleMs);
    return undefined;
  });
  if (!gate) return { entered: false };
  try {
    await gate.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }), 'utf8');
    return { entered: true, value: await action() };
  } finally {
    await gate.close();
    await releaseLock(gatePath, token);
  }
}

async function claimLock(path: string, staleMs: number): Promise<GateResult<Awaited<ReturnType<typeof tryAcquireLock>>>> {
  return underLockGate(path, staleMs, async () => {
    const current = await tryAcquireLock(path);
    if (current) return current;
    if (!await staleLock(path, staleMs)) return undefined;
    await unlink(path);
    return tryAcquireLock(path);
  });
}

async function releaseOwnedLock(path: string, token: string, retryMs: number, staleMs: number): Promise<void> {
  for (const attempt of LOCK_ATTEMPTS) {
    const released = await underLockGate(path, staleMs, () => releaseLock(path, token));
    if (released.entered) return;
    await new Promise(resolve => setTimeout(resolve, retryMs + Math.min(attempt, 20)));
  }
  throw storageError(`Storage lock gate is busy: ${path}.`, 'STORAGE_BUSY');
}

export async function withStorageLock<T>(path: string, action: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const staleMs = options.staleMs ?? 30_000;
  const retryMs = options.retryMs ?? 5;
  if (!Number.isFinite(staleMs) || staleMs < 0 || !Number.isFinite(retryMs) || retryMs <= 0) {
    throw new Error('Invalid storage lock timing.');
  }
  await ensurePrivateDirectory(dirname(path));
  for (const attempt of LOCK_ATTEMPTS) {
    const claim = await claimLock(path, staleMs);
    const owned = claim.entered ? claim.value : undefined;
    if (owned) {
      try { return await action(); }
      finally {
        await owned.handle.close();
        await releaseOwnedLock(path, owned.token, retryMs, staleMs);
      }
    }
    await new Promise(resolve => setTimeout(resolve, retryMs + Math.min(attempt, 20)));
  }
  throw storageError(`Storage lock is busy: ${path}.`, 'STORAGE_BUSY');
}
