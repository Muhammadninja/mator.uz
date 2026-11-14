/**
 * Re-resolve saved Garage vehicles' image identity — CLI for an operator.
 *
 *   npm run vehicle-images:reconcile                               # dry run (default)
 *   npm run vehicle-images:reconcile -- --apply                    # re-resolve, logged per vehicle
 *   npm run vehicle-images:reconcile -- --revert <runId>           # what a revert would restore
 *   npm run vehicle-images:reconcile -- --revert <runId> --apply   # restore a run's previous values
 *   ... --report <file.json>                                       # write the full report
 *
 * Rules (src/garage/vehicle-images/vehicle-image.reconcile.service.ts): only
 * vehicles resolved with an older resolver/registry version (or never) are
 * looked at; it only upgrades, never reassigns a verified vehicle, never
 * downgrades a requested one to review, and skips a vehicle changed meanwhile.
 * New pipeline requests are written to the outbox; the running backend's relay
 * delivers them (this CLI never calls the pipeline).
 *
 * It uses the DATABASE_URL Prisma resolves (Backend/.env): run the dry run and
 * read its report before --apply. Exit codes: 0 done, 1 refused or failed.
 */
import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'fs';
import { VehicleImagesService } from '../src/garage/vehicle-images/vehicle-images.service';
import { VehicleImageReconcileService } from '../src/garage/vehicle-images/vehicle-image.reconcile.service';
import { readVehicleImageConfig } from '../src/garage/vehicle-images/vehicle-image.config';
import type { PrismaService } from '../src/prisma/prisma.service';

const TAG = '[vehicle-images:reconcile]';

function parseArgs(argv: string[]) {
  const apply = argv.includes('--apply');
  const revertIndex = argv.indexOf('--revert');
  const reportIndex = argv.indexOf('--report');
  const revert = revertIndex >= 0 ? argv[revertIndex + 1] : undefined;
  const report = reportIndex >= 0 ? argv[reportIndex + 1] : undefined;
  if (revertIndex >= 0 && (!revert || revert.startsWith('--'))) throw new Error('--revert needs a run id');
  if (reportIndex >= 0 && (!report || report.startsWith('--'))) throw new Error('--report needs a file');
  return { apply, revert, report };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const config = readVehicleImageConfig((key) => process.env[key]);
    // Requests go to the outbox only; the relay of the running backend sends them.
    const delivery = { enabled: config.enabled };
    const queue = { add: () => Promise.reject(new Error('no queue in the CLI')) };
    const images = new VehicleImagesService(
      prisma as unknown as PrismaService,
      delivery as never,
      queue as never,
    );
    const reconcile = new VehicleImageReconcileService(prisma as unknown as PrismaService, images);
    if (args.revert) {
      const result = await reconcile.revert(args.revert, args.apply);
      console.log(`${TAG} ${args.apply ? 'reverted' : 'dry run of revert'}: ${JSON.stringify(result)}`);
      return;
    }
    const report = await reconcile.run({ apply: args.apply });
    const { changes, ...summary } = report;
    console.log(`${TAG} ${args.apply ? 'applied' : 'dry run'}: ${JSON.stringify(summary, null, 2)}`);
    for (const change of changes.slice(0, 25)) console.log(`${TAG}   ${change.vehicleId}: ${change.from} → ${change.to}`);
    if (changes.length > 25) console.log(`${TAG}   … ${changes.length - 25} more (use --report)`);
    if (args.report) writeFileSync(args.report, JSON.stringify(report, null, 2));
    if (!args.apply) console.log(`${TAG} nothing was written; rerun with --apply after reading the report`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(`${TAG} failed: ${(err as Error)?.message ?? err}`);
  process.exit(1);
});
