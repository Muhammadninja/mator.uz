/**
 * Exclusive lock files for Driver's Village runs.
 *
 * A lock file appears atomically and already complete — written to a temp
 * file, then hard-linked into place — holding { pid, hostname, label,
 * startedAt, bootId, processStart }.
 *
 * A held lock is NEVER taken over because of its age: a long import is still
 * an import. It is replaced only when its holder is provably gone:
 *   • it was taken before the last reboot (Linux boot id differs), or
 *   • its pid is not alive on this host, or
 *   • its pid now belongs to another process (Linux start time differs).
 * A lock written on another host, or one that cannot be read, is never
 * removed automatically; the busy error says to check and remove it by hand.
 *
 * Two locks use it:
 *   • the import lock — one real import at a time against the database. The
 *     import CLI takes it, so a manual run and a run started by the Telegram
 *     ingest can never overlap; a second import exits LOCK_BUSY_EXIT_CODE.
 *   • the ingest's sync lock in its state directory — one Telegram sync or
 *     login at a time (the TDLib session database is single-process).
 */
import { randomBytes } from 'crypto';
import {
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'fs';
import { hostname, tmpdir } from 'os';
import { join } from 'path';

/** Exit code of the import CLI when another import holds the import lock. */
export const LOCK_BUSY_EXIT_CODE = 3;

/**
 * Default import lock: one per host, shared by every checkout and user. A
 * systemd unit that runs imports must therefore not use PrivateTmp=, or both
 * it and manual runs must set DV_IMPORT_LOCK_FILE to the same path.
 */
export const DEFAULT_IMPORT_LOCK_FILE = join(
  tmpdir(),
  'mator-drivers-village-import.lock',
);

export function importLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.DV_IMPORT_LOCK_FILE?.trim() || DEFAULT_IMPORT_LOCK_FILE;
}

export interface LockInfo {
  pid: number;
  hostname: string;
  label: string;
  startedAt: string;
  /** Linux boot id when the lock was taken; null elsewhere. */
  bootId: string | null;
  /** Linux start time of the holder process (clock ticks); null elsewhere. */
  processStart: string | null;
}

/** What the lock asks the operating system about a holder. */
export interface ProcessProbe {
  bootId(): string | null;
  processStart(pid: number): string | null;
  isAlive(pid: number): boolean;
}

export const systemProbe: ProcessProbe = {
  bootId: () => readTrimmed('/proc/sys/kernel/random/boot_id'),
  processStart: (pid) => {
    const stat = readTrimmed(`/proc/${pid}/stat`);
    if (!stat) return null;
    // Field 22 (starttime); field 2, the command, may contain spaces.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  },
  isAlive: (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM: the process exists but belongs to another user.
      return isErrno(error, 'EPERM');
    }
  },
};

export interface LockOptions {
  /** Who holds the lock, for the busy message (e.g. 'import:drivers-village'). */
  label: string;
  /** Tests only: a stand-in for the operating system. */
  probe?: ProcessProbe;
}

export interface LockHandle {
  readonly path: string;
  /** Remove the lock if it is still ours. Safe to call more than once. */
  release(): void;
}

export class LockBusyError extends Error {
  constructor(
    readonly path: string,
    readonly holder: LockInfo | null,
  ) {
    super(
      holder
        ? `${path} is held by pid ${holder.pid} on ${holder.hostname} (${holder.label}, since ${holder.startedAt})${holder.hostname === hostname() ? '' : ' — another host: if that run is over, remove the file by hand'}`
        : `${path} exists but cannot be read — if no Driver's Village run is active, remove it by hand`,
    );
    this.name = 'LockBusyError';
  }
}

/** Take the lock or throw LockBusyError. A provably stale lock is replaced. */
export function acquireLock(path: string, options: LockOptions): LockHandle {
  const probe = options.probe ?? systemProbe;
  const info: LockInfo = {
    pid: process.pid,
    hostname: hostname(),
    label: options.label,
    startedAt: new Date().toISOString(),
    bootId: probe.bootId(),
    processStart: probe.processStart(process.pid),
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (createComplete(path, JSON.stringify(info))) return hold(path, info);
    const raw = readRaw(path);
    if (raw === null) continue; // released in between: try again
    const holder = parseLockInfo(raw);
    if (!holderIsGone(holder, probe)) throw new LockBusyError(path, holder);
    // Remove it only while it is still the file judged stale.
    if (readRaw(path) === raw) unlinkQuietly(path);
  }
  throw new LockBusyError(path, readLockInfo(path));
}

/** The holder recorded in a lock file; null when missing or unreadable. */
export function readLockInfo(path: string): LockInfo | null {
  const raw = readRaw(path);
  return raw === null ? null : parseLockInfo(raw);
}

/** Proof that the holder cannot be running any more; never its age. */
function holderIsGone(holder: LockInfo | null, probe: ProcessProbe): boolean {
  if (!holder || holder.hostname !== hostname()) return false;
  const boot = probe.bootId();
  if (holder.bootId && boot && holder.bootId !== boot) return true;
  if (!probe.isAlive(holder.pid)) return true;
  const start = holder.processStart ? probe.processStart(holder.pid) : null;
  return start !== null && start !== holder.processStart;
}

/** Create `path` with `content`, atomically; false when it already exists. */
function createComplete(path: string, content: string): boolean {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
  try {
    linkSync(tmp, path);
    return true;
  } catch (error) {
    if (isErrno(error, 'EEXIST')) return false;
    if (
      !['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].some((c) =>
        isErrno(error, c),
      )
    )
      throw error;
  } finally {
    unlinkQuietly(tmp);
  }
  // A file system without hard links: exclusive create, then write.
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if (isErrno(error, 'EEXIST')) return false;
    throw error;
  }
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return true;
}

function hold(path: string, info: LockInfo): LockHandle {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.off('exit', release);
    // Remove the file only while it is still ours.
    const current = readLockInfo(path);
    if (
      current &&
      current.pid === info.pid &&
      current.hostname === info.hostname &&
      current.startedAt === info.startedAt
    )
      unlinkQuietly(path);
  };
  process.on('exit', release);
  return { path, release };
}

function parseLockInfo(raw: string): LockInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (
    typeof o.pid !== 'number' ||
    typeof o.hostname !== 'string' ||
    typeof o.label !== 'string' ||
    typeof o.startedAt !== 'string'
  )
    return null;
  return {
    pid: o.pid,
    hostname: o.hostname,
    label: o.label,
    startedAt: o.startedAt,
    bootId: typeof o.bootId === 'string' ? o.bootId : null,
    processStart: typeof o.processStart === 'string' ? o.processStart : null,
  };
}

function readRaw(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }
}

function readTrimmed(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === code
  );
}
