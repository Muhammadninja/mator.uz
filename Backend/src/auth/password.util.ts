import { ServiceUnavailableException } from '@nestjs/common';
import * as argon2 from 'argon2';
import * as bcrypt from 'bcrypt';

/**
 * How many password hashes or verifications may run at once, and how many more
 * may wait.
 *
 * One Argon2id operation with this module's parameters (m=65536) holds 64 MiB
 * for its whole duration and occupies a libuv pool thread. The process runs as a
 * single PM2 fork capped at 500 MB, and the libuv pool (4 threads unless
 * UV_THREADPOOL_SIZE says otherwise) also serves DNS lookups for Payme, UzMaps
 * and SMS, file reads and other crypto. Unbounded, a burst of logins could push
 * the process past its memory cap or leave no thread for anything else.
 *
 * Default 2 at once: at most 128 MiB of KDF memory and half of a default pool.
 * Up to 8 more wait; beyond that a caller is told to retry rather than queued,
 * so the queue cannot grow into a memory problem of its own. The parameters of
 * Argon2 are not lowered to buy throughput.
 */
const DEFAULT_KDF_CONCURRENCY = 2;
const DEFAULT_KDF_MAX_QUEUE = 8;
const MAX_KDF_CONCURRENCY = 16;
const MAX_KDF_QUEUE = 256;

/** Thrown when the password-hashing queue is full. Answers HTTP 503. */
export class PasswordKdfBusyError extends ServiceUnavailableException {
  constructor() {
    super({
      code: 'AUTH_BUSY',
      message: 'Too many sign-in attempts are being processed. Try again shortly.',
    });
  }
}

function boundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(raw);
  if (raw === undefined || raw.trim() === '' || !Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

class KdfGate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    readonly concurrency: number,
    readonly maxQueue: number,
  ) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      if (this.waiting.length >= this.maxQueue) throw new PasswordKdfBusyError();
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await work();
    } finally {
      // Hand the slot straight to the next waiter, so `active` never dips and a
      // newcomer cannot jump the queue.
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  stats() {
    return { active: this.active, waiting: this.waiting.length };
  }
}

let gate: KdfGate | undefined;

function kdfGate(): KdfGate {
  gate ??= new KdfGate(
    boundedInt(
      process.env.PASSWORD_KDF_CONCURRENCY,
      DEFAULT_KDF_CONCURRENCY,
      1,
      MAX_KDF_CONCURRENCY,
    ),
    boundedInt(
      process.env.PASSWORD_KDF_MAX_QUEUE,
      DEFAULT_KDF_MAX_QUEUE,
      0,
      MAX_KDF_QUEUE,
    ),
  );
  return gate;
}

/** Current limits and load of the password KDF gate. */
export function passwordKdfStats() {
  const g = kdfGate();
  return { concurrency: g.concurrency, maxQueue: g.maxQueue, ...g.stats() };
}

/** Re-read the limits from the environment. For tests. */
export function resetPasswordKdfGate(): void {
  gate = undefined;
}

/**
 * All new passwords are hashed with Argon2id (OWASP-recommended).
 * Verification stays backward-compatible with legacy bcrypt hashes so
 * existing users created before this change can still log in; their hash
 * is transparently upgraded on next successful login (see AuthService).
 */
export async function hashPassword(plain: string): Promise<string> {
  return kdfGate().run(() => argon2.hash(plain, { type: argon2.argon2id }));
}

/**
 * @throws PasswordKdfBusyError when the queue is full. Deliberately not folded
 * into `false`: "could not check" must never read as "wrong password", which
 * would count a failed login against an account nobody tried to guess.
 */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  const isArgon = hash.startsWith('$argon2');
  if (!isArgon && !hash.startsWith('$2')) return false;
  return kdfGate().run(async () => {
    try {
      return isArgon
        ? await argon2.verify(hash, plain)
        : await bcrypt.compare(plain, hash); // legacy bcrypt
    } catch {
      return false;
    }
  });
}

/** True when a stored hash is a legacy (non-Argon2) hash that should be re-hashed. */
export function needsRehash(hash: string): boolean {
  return !hash.startsWith('$argon2');
}
