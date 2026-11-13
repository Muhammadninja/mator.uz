/**
 * OEM cross-reference DRY-RUN (Wave 4). Validates a named dataset, finds
 * candidate pairs in a catalog snapshot, and prints what a separate,
 * separately approved import would have to do.
 *
 * READ-ONLY BY CONSTRUCTION: this script makes no database, Redis or network
 * connection and loads no .env. It reads two inputs only — a dataset compiled
 * into the code (by name) and the JSON file that
 * scripts/sql/oem-cross-reference-snapshot.sql prints. There is no --apply:
 * Wave 4 has no import, and no table to import into (see
 * docs/OEM_CROSS_REFERENCE_SCHEMA_PROPOSAL.md).
 *
 * Both arguments are required, so a run never picks a dataset or a catalog by
 * default. Exit code 1 when the plan has errors, 2 on bad arguments or an
 * unreadable snapshot.
 *
 * Run:  npm run oem-xref:dry-run -- --dataset=wave-4 --snapshot=oem-xref-snapshot.json
 */
import { readFileSync } from 'node:fs';
import {
  CatalogSnapshot,
  XrefSnapshotFormatError,
  parseCatalogSnapshot,
} from '../src/prisma/oem-xref/oem-xref.catalog';
import { OEM_XREF_DATASETS } from '../src/prisma/oem-xref/oem-xref.datasets';
import {
  isXrefPlanBlocked,
  planOemCrossReference,
} from '../src/prisma/oem-xref/oem-xref.plan';
import { formatXrefReport } from '../src/prisma/oem-xref/oem-xref.report';

const KNOWN = ['dataset', 'snapshot'];

function usage(message: string): never {
  console.error(
    `${message}\nUsage: npm run oem-xref:dry-run -- --dataset=<${Object.keys(OEM_XREF_DATASETS).join('|')}> --snapshot=<file.json>`,
  );
  process.exit(2);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--apply'))
    usage(
      '--apply does not exist: Wave 4 imports nothing. This is a dry-run only.',
    );
  const values = new Map<string, string>();
  for (const a of args) {
    const m = /^--([a-z]+)=(.+)$/.exec(a);
    if (!m || !KNOWN.includes(m[1])) usage(`Unknown argument "${a}".`);
    values.set(m[1], m[2]);
  }
  const name = values.get('dataset');
  const file = values.get('snapshot');
  if (!name) usage('--dataset is required.');
  if (!file)
    usage(
      '--snapshot is required (the JSON printed by scripts/sql/oem-cross-reference-snapshot.sql).',
    );
  const dataset = OEM_XREF_DATASETS[name];
  if (!dataset) usage(`Unknown dataset "${name}".`);

  let snapshot: CatalogSnapshot;
  try {
    snapshot = parseCatalogSnapshot(readFileSync(file, 'utf8'));
  } catch (err) {
    if (
      err instanceof XrefSnapshotFormatError ||
      (err as NodeJS.ErrnoException).code
    )
      usage(`Cannot use snapshot ${file}: ${(err as Error).message}`);
    throw err;
  }
  const plan = planOemCrossReference(dataset, snapshot, {
    datasetName: name,
    today: new Date(),
  });
  console.log(
    formatXrefReport(
      plan,
      `snapshot file ${file}${snapshot.database ? ` of database "${snapshot.database}"` : ''}; no database connection`,
    ),
  );
  if (isXrefPlanBlocked(plan)) process.exitCode = 1;
}

main();
