/**
 * Vehicle reference seed: adds the makes/models the Garage picker is missing.
 * The datasets and their evidence live in src/prisma/seed-data/ (G-2:
 * vehicle-reference.seed.ts, Wave 1: vehicle-reference-wave1.seed.ts), the
 * dataset list in src/prisma/vehicle-reference-datasets.ts, and the rules in
 * src/prisma/vehicle-reference-seed.ts.
 *
 * SAFE BY DEFAULT: dry-run prints the complete plan and writes nothing.
 * --apply writes it in one transaction and then clears the Reference API's
 * cached makes/models lists (24h TTL), so the change shows up immediately.
 * Additive and idempotent: never renames, re-sorts, deletes or re-keys an
 * existing row, never writes a field of an existing row, and a second run
 * finds nothing to do.
 *
 * --snapshot=<file> plans against the JSON from
 * scripts/sql/vehicle-reference-snapshot.sql instead of a database: no
 * database connection is made, and --apply is refused.
 *
 * This is NOT `npm run seed`, which must never run against production.
 *
 * Exit code 1 when the plan is blocked (conflicts/errors) or the run fails;
 * 2 on bad arguments.
 *
 * Run:  npm run seed:vehicle-reference -- --dataset=wave-1 --snapshot=snapshot.json
 *       npm run seed:vehicle-reference -- --dataset=wave-1            # dry-run on DATABASE_URL
 *       npm run seed:vehicle-reference -- --dataset=wave-1 --apply
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { REFERENCE_DATASETS } from '../src/prisma/vehicle-reference-datasets';
import {
  isBlocked,
  planVehicleReferenceSeed,
} from '../src/prisma/vehicle-reference-plan';
import {
  referenceCacheKeys,
  ReferenceSeedAbort,
  runVehicleReferenceSeed,
} from '../src/prisma/vehicle-reference-seed';
import { formatVehicleReferenceReport } from '../src/prisma/vehicle-reference-report';
import { parseReferenceSnapshot } from '../src/prisma/vehicle-reference-snapshot';

const APPLY = process.argv.includes('--apply');
const argValue = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const DATASET_NAME = argValue('dataset');
const SNAPSHOT = argValue('snapshot');

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

function usage(message: string): never {
  console.error(
    `${message}\nUsage: npm run seed:vehicle-reference -- --dataset=<${Object.keys(REFERENCE_DATASETS).join('|')}> [--snapshot=<file.json>] [--apply]`,
  );
  process.exit(2);
}

/** Offline dry-run: plan against a snapshot file; never touches a database. */
function planFromSnapshot(datasetName: string, file: string): void {
  const dataset = REFERENCE_DATASETS[datasetName];
  const { capturedAt, snapshot } = parseReferenceSnapshot(
    readFileSync(file, 'utf8'),
  );
  const plan = planVehicleReferenceSeed(dataset, snapshot);
  console.log(
    formatVehicleReferenceReport(plan, {
      outcome: 'dry-run',
      target: `snapshot file ${file} (captured ${capturedAt ?? 'at an unknown time'}); no database connection`,
    }),
  );
  if (isBlocked(plan)) process.exitCode = 1;
}

async function main(): Promise<void> {
  if (!DATASET_NAME) usage('--dataset is required.');
  const dataset = REFERENCE_DATASETS[DATASET_NAME];
  if (!dataset) usage(`Unknown dataset "${DATASET_NAME}".`);
  if (SNAPSHOT !== undefined) {
    if (APPLY) usage('--apply cannot be combined with --snapshot.');
    planFromSnapshot(DATASET_NAME, SNAPSHOT);
    return;
  }

  const prisma = new PrismaClient();
  const target = describeTarget();
  try {
    const { plan, applied } = await runVehicleReferenceSeed(prisma, {
      apply: APPLY,
      dataset,
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
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('seed:vehicle-reference FAILED:', err);
  process.exitCode = 1;
});
