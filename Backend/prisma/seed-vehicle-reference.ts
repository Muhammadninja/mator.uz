/**
 * G-2 vehicle reference seed: adds the makes/models the Garage picker is missing
 * and disables the empty `leapmotor` make. The data and its evidence live in
 * src/prisma/seed-data/vehicle-reference.seed.ts; the rules in
 * src/prisma/vehicle-reference-seed.ts.
 *
 * SAFE BY DEFAULT: dry-run prints the complete plan and writes nothing.
 * --apply writes it in one transaction and then clears the Reference API's
 * cached makes/models lists (24h TTL), so the change shows up immediately.
 * Additive and idempotent: never renames, re-sorts, deletes or re-keys an
 * existing row, and a second run finds nothing to do.
 *
 * Exit code 1 when the plan is blocked (conflicts/errors) or the run fails.
 *
 * Run:  npm run seed:vehicle-reference              # dry-run
 *       npm run seed:vehicle-reference -- --apply
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { isBlocked } from '../src/prisma/vehicle-reference-plan';
import {
  referenceCacheKeys,
  ReferenceSeedAbort,
  runVehicleReferenceSeed,
} from '../src/prisma/vehicle-reference-seed';
import { formatVehicleReferenceReport } from '../src/prisma/vehicle-reference-report';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

/** host:port/database of DATABASE_URL, never the credentials. */
function describeTarget(): string {
  try {
    const url = new URL(process.env.DATABASE_URL ?? '');
    return `${url.host}${url.pathname}`;
  } catch {
    return '(DATABASE_URL is not set or not a URL)';
  }
}

/** Best effort: a failure only means the API shows the change after the TTL. */
async function clearReferenceCache(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const manual = `redis-cli DEL ${keys.join(' ')}`;
  const host = process.env.REDIS_HOST;
  const port = Number(process.env.REDIS_PORT);
  if (!host || !port) {
    console.warn(
      `\n⚠ REDIS_HOST/REDIS_PORT are not set, so the API keeps serving the old lists for up to 24h. Clear them with:\n  ${manual}`,
    );
    return;
  }
  const redis = new Redis({
    host,
    port,
    password: process.env.REDIS_PASSWORD || undefined,
    lazyConnect: true,
    connectTimeout: 5_000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  // Keep the socket error (e.g. ECONNREFUSED) for the warning; without a
  // listener ioredis also prints it as an "Unhandled error event".
  let socketError: Error | undefined;
  redis.on('error', (err: Error) => (socketError = err));
  try {
    await redis.connect();
    const removed = await redis.del(...keys);
    console.log(
      `\nReference cache cleared (${removed} of ${keys.length} keys were cached): ${keys.join(', ')}`,
    );
  } catch (err) {
    const cause = socketError ?? err;
    const message = cause instanceof Error ? cause.message : String(cause);
    console.warn(
      `\n⚠ Could not clear the reference cache (${message}). The API keeps serving the old lists for up to 24h. Clear them with:\n  ${manual}`,
    );
  } finally {
    redis.disconnect();
  }
}

async function main(): Promise<void> {
  const target = describeTarget();
  try {
    const { plan, applied } = await runVehicleReferenceSeed(prisma, {
      apply: APPLY,
    });
    console.log(
      formatVehicleReferenceReport(plan, {
        outcome: APPLY ? 'applied' : 'dry-run',
        target,
      }),
    );
    if (isBlocked(plan)) process.exitCode = 1;
    if (applied) await clearReferenceCache(referenceCacheKeys(plan));
  } catch (err) {
    if (!(err instanceof ReferenceSeedAbort)) throw err;
    console.log(
      formatVehicleReferenceReport(err.plan, { outcome: 'blocked', target }),
    );
    if (!isBlocked(err.plan)) console.error(`\n${err.message}`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error('seed:vehicle-reference FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
