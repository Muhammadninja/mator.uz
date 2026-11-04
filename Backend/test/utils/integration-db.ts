/**
 * Guard + wiring for the integration specs, which run against a REAL PostgreSQL
 * because what they pin (foreign-key actions, row locks, transaction isolation)
 * does not exist in a Prisma mock.
 *
 * They read TEST_DATABASE_URL and NEVER DATABASE_URL, and refuse anything that
 * is not an obviously disposable local database: the specs create and delete
 * rows, so being pointed at a shared database must be an error, not a risk.
 * Without the variable the suites are skipped, so `npm test` and CI stay
 * DB-independent.
 */

import { Prisma, PrismaClient } from '@prisma/client';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const DISPOSABLE_DB_NAME = /(_test|_it|_audit)$/;

/** The validated local URL, or null when the integration suites should skip. */
export function integrationDatabaseUrl(): string | null {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) return null;

  const url = new URL(raw);
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(
      `TEST_DATABASE_URL must point at localhost, got "${url.hostname}" — refusing to run destructive specs`,
    );
  }
  const dbName = url.pathname.replace(/^\//, '');
  if (!DISPOSABLE_DB_NAME.test(dbName)) {
    throw new Error(
      `TEST_DATABASE_URL database "${dbName}" must end in _test, _it or _audit — refusing to run destructive specs`,
    );
  }
  return raw;
}

const databaseUrl = integrationDatabaseUrl();

/** `describe` when a disposable database is configured, otherwise `describe.skip`. */
export const describeWithDb = databaseUrl ? describe : describe.skip;

export function integrationPrisma(): PrismaClient {
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is not set');
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Hold a transaction open across `during`: run `write` (uncommitted), then
 * `during` while its row locks are still held, then commit. This is what makes a
 * race deterministic instead of a matter of timing.
 */
export async function whileUncommitted<T>(
  prisma: PrismaClient,
  write: (tx: Prisma.TransactionClient) => Promise<unknown>,
  during: () => Promise<T>,
  holdMs = 400,
): Promise<T> {
  let written!: () => void;
  const hasWritten = new Promise<void>((resolve) => {
    written = resolve;
  });
  const writer = prisma.$transaction(
    async (tx) => {
      await write(tx);
      written();
      await sleep(holdMs);
    },
    { timeout: 15_000 },
  );
  await hasWritten;
  const result = await during();
  await writer;
  return result;
}
