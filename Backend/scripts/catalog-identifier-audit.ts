/**
 * Catalog part-number data-quality audit (Wave 5). Prints what is missing,
 * duplicated, conflicting or ambiguous in the catalog's GM/OEM numbers.
 *
 * READ-ONLY BY CONSTRUCTION: this script makes no database, Redis or network
 * connection and loads no .env. Its only input is the JSON file that
 * scripts/sql/catalog-identifier-snapshot.sql prints. There is no --apply: it
 * never merges, deletes or rewrites a product or a number.
 *
 * Exit code 0 on a report (findings are not errors), 2 on bad arguments or an
 * unreadable snapshot.
 *
 * Run:  npm run catalog:identifier-audit -- --snapshot=catalog-identifier-snapshot.json [--all] [--json]
 */
import { readFileSync } from 'node:fs';
import {
  AuditSnapshot,
  AuditSnapshotFormatError,
  parseAuditSnapshot,
} from '../src/prisma/identifier-audit/identifier-audit.snapshot';
import {
  auditIdentifiers,
  formatIdentifierAudit,
} from '../src/prisma/identifier-audit/identifier-audit';

function usage(message: string): never {
  console.error(
    `${message}\nUsage: npm run catalog:identifier-audit -- --snapshot=<file.json> [--all] [--json]`,
  );
  process.exit(2);
}

function main(): void {
  let file: string | undefined;
  let all = false;
  let json = false;
  for (const a of process.argv.slice(2)) {
    if (a === '--apply')
      usage('--apply does not exist: this audit only reports.');
    else if (a === '--all') all = true;
    else if (a === '--json') json = true;
    else if (a.startsWith('--snapshot=')) file = a.slice('--snapshot='.length);
    else usage(`Unknown argument "${a}".`);
  }
  if (!file) {
    usage(
      '--snapshot is required (the JSON printed by scripts/sql/catalog-identifier-snapshot.sql).',
    );
  }
  let snapshot: AuditSnapshot;
  try {
    snapshot = parseAuditSnapshot(readFileSync(file, 'utf8'));
  } catch (err) {
    if (
      err instanceof AuditSnapshotFormatError ||
      (err as NodeJS.ErrnoException).code
    ) {
      usage(`Cannot use snapshot ${file}: ${(err as Error).message}`);
    }
    throw err;
  }
  const report = auditIdentifiers(snapshot);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(
    formatIdentifierAudit(
      report,
      `snapshot file ${file}${snapshot.database ? ` of database "${snapshot.database}"` : ''} captured ${snapshot.capturedAt}; no database connection`,
      all ? Number.MAX_SAFE_INTEGER : 20,
    ),
  );
}

main();
