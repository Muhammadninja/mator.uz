/**
 * Buyer search before vs after Wave 5, on the same queries, over a catalog
 * snapshot. Shows which queries list other parts, or the same parts in
 * another order, and which first pages change.
 *
 * READ-ONLY BY CONSTRUCTION: no database, Redis or network connection, no
 * .env. Inputs: the JSON that scripts/sql/catalog-identifier-snapshot.sql
 * prints, and optionally a query file (one query per line, `#` comments) —
 * e.g. real buyer queries. Without --only-file, queries are also derived from
 * the snapshot (every stored number, short numbers beside a word, title words).
 *
 * Exit code 0 on a report, 2 on bad arguments or an unreadable input.
 *
 * Run:  npm run catalog:search-compare -- --snapshot=<file.json> [--queries=<file.txt>] [--only-file] [--page-size=20] [--all] [--json]
 */
import { readFileSync } from 'node:fs';
import {
  AuditSnapshot,
  AuditSnapshotFormatError,
  parseAuditSnapshot,
} from '../src/prisma/identifier-audit/identifier-audit.snapshot';
import {
  CompareQuery,
  compareSearch,
  formatSearchComparison,
  generateQueries,
} from '../src/prisma/identifier-audit/search-compare';

function usage(message: string): never {
  console.error(
    `${message}\nUsage: npm run catalog:search-compare -- --snapshot=<file.json> [--queries=<file.txt>] [--only-file] [--page-size=20] [--all] [--json]`,
  );
  process.exit(2);
}

function main(): void {
  let snapshotFile: string | undefined;
  let queriesFile: string | undefined;
  let onlyFile = false;
  let all = false;
  let json = false;
  let pageSize = 20;
  for (const a of process.argv.slice(2)) {
    if (a === '--apply')
      usage('--apply does not exist: this comparison only reports.');
    else if (a === '--only-file') onlyFile = true;
    else if (a === '--all') all = true;
    else if (a === '--json') json = true;
    else if (a.startsWith('--snapshot=')) snapshotFile = a.slice(11);
    else if (a.startsWith('--queries=')) queriesFile = a.slice(10);
    else if (a.startsWith('--page-size=')) {
      pageSize = Number(a.slice(12));
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100)
        usage('--page-size must be an integer from 1 to 100.');
    } else usage(`Unknown argument "${a}".`);
  }
  if (!snapshotFile)
    usage(
      '--snapshot is required (the JSON printed by scripts/sql/catalog-identifier-snapshot.sql).',
    );
  if (onlyFile && !queriesFile) usage('--only-file needs --queries.');

  let snapshot: AuditSnapshot;
  let fileQueries: CompareQuery[] = [];
  try {
    snapshot = parseAuditSnapshot(readFileSync(snapshotFile, 'utf8'));
    if (queriesFile) {
      fileQueries = readFileSync(queriesFile, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((text) => ({ text, source: 'file' as const }));
    }
  } catch (err) {
    if (
      err instanceof AuditSnapshotFormatError ||
      (err as NodeJS.ErrnoException).code
    )
      usage(`Cannot read input: ${(err as Error).message}`);
    throw err;
  }
  const queries = [
    ...fileQueries,
    ...(onlyFile ? [] : generateQueries(snapshot)),
  ];
  const result = compareSearch(snapshot, queries, pageSize);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    formatSearchComparison(
      result,
      `snapshot file ${snapshotFile}${snapshot.database ? ` of database "${snapshot.database}"` : ''} captured ${snapshot.capturedAt}; no database connection`,
      all ? Number.MAX_SAFE_INTEGER : 15,
    ),
  );
}

main();
