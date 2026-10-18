/**
 * File-system rules for the Telegram ingest's state directory, which holds the
 * Telegram session (the TDLib database — whoever can read it controls the
 * account), the downloaded exports and the ledger.
 *
 *   • The state directory is created by the operator (docs §Deployment),
 *     never by the code: absolute, a real directory (not a symlink), owned by
 *     the user running the ingest, no group/other access (0700), and outside
 *     the project and any repository, so it can never be committed.
 *   • Everything the ingest creates is private: the entry scripts set umask
 *     0077, directories are created 0700 and files 0600 explicitly.
 *   • Writes of the ledger are atomic (temp file + fsync + rename).
 */
import { createHash, randomBytes } from 'crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  writeSync,
} from 'fs';
import { dirname, isAbsolute, join, relative, sep } from 'path';

export class InsecurePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsecurePathError';
  }
}

/** True when `child` is `parent` itself or lies below it. */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return (
    rel === '' ||
    (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  );
}

/**
 * Throws InsecurePathError unless `dir` is a private directory outside
 * `projectRoot` and outside every repository / package on the way to `/`.
 */
export function assertPrivateStateDir(dir: string, projectRoot: string): void {
  if (!isAbsolute(dir)) {
    throw new InsecurePathError(
      `DV_TELEGRAM_STATE_DIR must be an absolute path (got a relative one).`,
    );
  }
  const st = statOrNull(dir);
  if (!st) {
    throw new InsecurePathError(
      `State directory ${dir} does not exist. Create it as the user that runs the ingest: install -d -m 0700 ${dir}`,
    );
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new InsecurePathError(
      `State directory ${dir} must be a real directory, not a symlink or a file.`,
    );
  }
  assertOwnedByMe(dir, st.uid);
  if (st.mode & 0o077) {
    throw new InsecurePathError(
      `State directory ${dir} is accessible to other users (mode ${modeString(st.mode)}). Run: chmod 700 ${dir}`,
    );
  }
  const real = realpathSync(dir);
  if (isInside(real, realpathSync(projectRoot))) {
    throw new InsecurePathError(
      `State directory ${dir} is inside the project (${projectRoot}). The Telegram session must live outside the repository.`,
    );
  }
  for (let d = real; ; d = dirname(d)) {
    for (const marker of ['.git', 'package.json']) {
      if (existsSync(join(d, marker))) {
        throw new InsecurePathError(
          `State directory ${dir} is inside ${d}, which contains ${marker}. Use a directory outside any repository or package, e.g. /var/lib/mator-dv-telegram.`,
        );
      }
    }
    if (dirname(d) === d) break;
  }
}

/**
 * Throws unless an existing `path` is private (owned by this user, no
 * group/other access). A missing path is fine.
 */
export function assertPrivateIfExists(path: string): void {
  const st = statOrNull(path);
  if (!st) return;
  if (st.isSymbolicLink()) {
    throw new InsecurePathError(`${path} must not be a symlink.`);
  }
  assertOwnedByMe(path, st.uid);
  if (st.mode & 0o077) {
    throw new InsecurePathError(
      `${path} is accessible to other users (mode ${modeString(st.mode)}). Run: chmod ${st.isDirectory() ? '700' : '600'} ${path}`,
    );
  }
}

/** mkdir -p with mode 0700; an existing directory is tightened to 0700. */
export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

/** Replace `path` atomically with `data` (mode 0600). */
export function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  try {
    // Persist the rename itself.
    const dirFd = openSync(dirname(path), 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Directory fsync is not supported everywhere; the rename is still atomic.
  }
}

/**
 * A local name for a file whose name came from Telegram: no directory parts,
 * only [A-Za-z0-9._-], no leading dot, at most 120 characters.
 */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return cleaned || 'document';
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** True when the first `limit` bytes contain a NUL byte (a binary file). */
export function hasNulByte(path: string, limit = 64 * 1024): boolean {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(limit);
    const n = readSync(fd, buf, 0, limit, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

function statOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function assertOwnedByMe(path: string, uid: number): void {
  if (typeof process.getuid === 'function' && uid !== process.getuid()) {
    throw new InsecurePathError(
      `${path} is owned by uid ${uid}, not by the user running the ingest (uid ${process.getuid()}).`,
    );
  }
}

function modeString(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, '0');
}
