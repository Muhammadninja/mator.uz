/**
 * Driver's Village CLASSIFICATION import — CLI. Applies a prepared
 * classification file (code_1c with category_id / subcategory_id and/or
 * vehicle_make / vehicle_model) to positions the price/stock import created.
 * Run by an operator only: the Telegram ingest timer never runs it.
 *
 *   npm run drivers-village:classify -- <file.txt>                           # dry run (default)
 *   npm run drivers-village:classify -- <file.txt> --apply --confirm=<code>  # apply
 *
 * The dry run plans everything and writes nothing; it prints the confirmation
 * code: the first 12 hex characters of the file's SHA-256. --apply needs that
 * code, so only the very file that was reviewed can be applied.
 *
 * Options:
 *   --encoding=<enc>        utf-8 | x-mac-cyrillic | windows-1251 (default: detected)
 *   --report-dir=<dir>      Where the JSON report and issues CSV go
 *                           (default: the input file's directory)
 *
 * Rules (src/imports/drivers-village/drivers-village-classification.rules.ts): a
 * category is applied only to a position that is not classified (its catalog
 * part sits in cat_uncategorized) or below its stored category; a category
 * set in Mator is never replaced (manual_category_preserved); unknown,
 * inactive or contradictory categories change nothing; vehicles are only
 * added; prices, stock, names, photos and catalog settings are never written;
 * positions are never created. A real run holds the host-wide import lock.
 * Exit codes: 0 = nothing to review, 2 = finished with warnings or errors in
 * the report, 1 = aborted or refused, 3 = another import is running.
 */
import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, extname, join, resolve } from 'path';
import { CatalogProjectionService } from '../src/catalog/projection/catalog-projection.service';
import { PrismaService } from '../src/prisma/prisma.service';
import type { ClassificationReport } from '../src/imports/drivers-village/drivers-village-classification.report';
import { DriversVillageClassificationService } from '../src/imports/drivers-village/drivers-village-classification.service';
import { PrismaClassificationStore } from '../src/imports/drivers-village/drivers-village-classification.store';
import { IMPORT_LIMITS } from '../src/imports/drivers-village/drivers-village.constants';
import { issuesToCsv } from '../src/imports/drivers-village/drivers-village.report';
import {
  acquireLock,
  importLockPath,
  LOCK_BUSY_EXIT_CODE,
  LockBusyError,
  type LockHandle,
} from '../src/imports/drivers-village/import-lock';
import {
  isSupportedEncoding,
  SUPPORTED_ENCODINGS,
} from '../src/imports/drivers-village/tsv-reader';

const TAG = '[drivers-village:classify]';
const SHOWN = 15;

interface CliArgs {
  file: string;
  apply: boolean;
  confirm?: string;
  encoding?: (typeof SUPPORTED_ENCODINGS)[number];
  reportDir?: string;
}

function fail(message: string): never {
  console.error(`${TAG} ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  const args: Partial<CliArgs> = { apply: false };
  for (const a of argv) {
    if (a === '--apply') args.apply = true;
    else if (a.startsWith('--confirm=')) args.confirm = a.slice(10).trim();
    else if (a.startsWith('--encoding=')) {
      const enc = a.slice('--encoding='.length);
      if (!isSupportedEncoding(enc))
        fail(`--encoding must be one of: ${SUPPORTED_ENCODINGS.join(', ')}`);
      args.encoding = enc;
    } else if (a.startsWith('--report-dir='))
      args.reportDir = a.slice('--report-dir='.length);
    else if (a === '--dry-run') args.apply = false;
    else if (a.startsWith('--')) fail(`Unknown option ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 1)
    fail(
      'Usage: npm run drivers-village:classify -- <file.txt> [--apply --confirm=<code>] [--encoding=…] [--report-dir=…]',
    );
  return { ...args, file: resolve(positional[0]) } as CliArgs;
}

/** Host and database name only — never the user, password or query string. */
function describeDatabase(): string {
  try {
    const url = new URL(process.env.DATABASE_URL ?? '');
    return `${url.hostname}/${url.pathname.replace(/^\//, '')}`;
  } catch {
    return '(DATABASE_URL not set or unparseable)';
  }
}

function printSummary(
  report: ClassificationReport,
  files: string[],
  confirmCode: string,
  file: string,
): void {
  const s = report.summary;
  console.log(
    `\n${TAG} ${report.meta.mode.toUpperCase()} — ${report.meta.file} (${report.meta.encoding}${report.meta.encodingDetected ? ', detected' : ''}; ${report.meta.delimiter ?? 'unknown'}-delimited)`,
  );
  console.table({
    'Rows in the file': s.totalRows,
    'Rows not usable (code_1c / columns)': s.rejectedRows,
    'Codes (one position each)': s.codes,
    'Positions found': s.positionsFound,
    'Codes without a position (never created here)': s.positionsNotFound,
    'Category assigned (was not classified)': s.category.assign,
    'Category refined below the stored one': s.category.refine,
    'Category already the same': s.category.unchanged,
    'Category set in Mator kept (manual_category_preserved)':
      s.category.preserved,
    'Category unknown / inactive / contradictory (not changed)':
      s.category.invalid,
    'Rows of a code disagree on the category (not changed)':
      s.category.conflict,
    'No category in the file': s.category.none,
    'Positions getting new vehicle links': s.positionsWithNewVehicles,
    'Model links added / make-wide links added': `${s.modelLinksAdded} / ${s.makeLinksAdded}`,
    'Import-universal flag replaced by the named vehicles': s.universalCleared,
    'Positions with Fitment Studio bindings (kept)':
      s.positionsWithCuratedFitment,
    'Positions to write': s.positionsToApply,
  });
  if (report.categoryProblems.length) {
    console.log('\nCategory problems in the file (fix them, then re-run):');
    for (const p of report.categoryProblems.slice(0, SHOWN))
      console.log(`  ${p.positions}× ${p.code}: ${p.message}`);
    if (report.categoryProblems.length > SHOWN)
      console.log(
        `  … and ${report.categoryProblems.length - SHOWN} more in the JSON report (categoryProblems)`,
      );
  }
  const preserved = report.positions.filter(
    (p) => p.category.action === 'preserved',
  );
  if (preserved.length) {
    console.log(
      '\nCategories set in Mator, kept (the file value is ignored — manual_category_preserved):',
    );
    for (const p of preserved.slice(0, SHOWN))
      console.log(
        `  ${p.code1c}: keeps "${p.category.existing}"; file: ${p.category.file?.categoryId ?? ''} > ${p.category.file?.subcategoryId ?? ''}`,
      );
    if (preserved.length > SHOWN)
      console.log(
        `  … and ${preserved.length - SHOWN} more in the JSON report (positions[].category)`,
      );
  }
  if (report.vehicleProblems.length) {
    console.log('\nVehicle cells not applied:');
    for (const v of report.vehicleProblems.slice(0, SHOWN))
      console.log(`  ${v.rows}× ${v.message}`);
  }
  if (report.environment.issues.length) {
    console.log('\nEnvironment (this database, not the source file):');
    for (const i of report.environment.issues) console.log(`  • ${i.message}`);
  }
  if (s.written)
    console.table({
      'Positions written': s.written.positions,
      'Categories written': s.written.categoriesWritten,
      'Categories changed in Mator meanwhile (kept)':
        s.written.categoriesKeptChanged,
      Projected: s.written.projected,
      'Projection failures': s.written.projectionFailures,
    });
  if (report.meta.aborted)
    console.error(`\nABORTED: ${report.meta.abortReason}`);
  console.log(`\nReport: ${files.join('\n        ')}`);
  if (report.meta.mode === 'dry-run' && !report.meta.aborted)
    console.log(
      `\nNothing was written. To apply exactly this file:\n  npm run drivers-village:classify -- "${file}" --apply --confirm=${confirmCode}`,
    );
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (['.xlsx', '.xls', '.xlsm'].includes(extname(args.file).toLowerCase()))
    fail(
      'Excel workbooks are not read directly. In Excel use File → Save As → "Tab-delimited Text (.txt)" and pass that file.',
    );
  let size: number;
  try {
    const st = statSync(args.file);
    if (!st.isFile()) fail(`${args.file} is not a file`);
    size = st.size;
  } catch {
    fail(`Cannot read ${args.file}`);
  }
  if (size > IMPORT_LIMITS.maxFileBytes)
    fail(`File is ${size} bytes; the limit is ${IMPORT_LIMITS.maxFileBytes}.`);
  const bytes = readFileSync(args.file);
  const confirmCode = createHash('sha256')
    .update(bytes)
    .digest('hex')
    .slice(0, 12);

  if (!args.apply && args.confirm) fail('--confirm is only used with --apply.');
  if (args.apply && args.confirm !== confirmCode)
    fail(
      args.confirm
        ? '--confirm does not match this file: it changed since the dry run, or another file was given. Run the dry run again and review its report.'
        : '--apply needs --confirm=<code>. Run the dry run first: it prints the code of exactly the file it reviewed.',
    );

  // One real import at a time (a dry run writes nothing and takes no lock).
  let lock: LockHandle | null = null;
  if (args.apply) {
    try {
      lock = acquireLock(importLockPath(), {
        label: 'drivers-village:classify',
      });
    } catch (error) {
      if (!(error instanceof LockBusyError)) throw error;
      console.error(
        `${TAG} Another import is running — ${error.message}. Nothing was done.`,
      );
      return LOCK_BUSY_EXIT_CODE;
    }
  }

  console.log(
    `${TAG} mode=${args.apply ? 'APPLY' : 'dry-run'} database=${describeDatabase()}`,
  );
  const prisma = new PrismaClient();
  try {
    const service = new DriversVillageClassificationService(
      new PrismaClassificationStore(prisma),
      new CatalogProjectionService(prisma as unknown as PrismaService),
      (m) => console.log(`${TAG} ${m}`),
    );
    const report = await service.run(bytes, basename(args.file), {
      dryRun: !args.apply,
      encoding: args.encoding,
    });

    const dir = resolve(args.reportDir ?? dirname(args.file));
    mkdirSync(dir, { recursive: true });
    const stamp = report.meta.startedAt.replace(/[:.]/g, '-');
    const base = `drivers-village-classification-${report.meta.mode}-${stamp}`;
    const jsonPath = join(dir, `${base}.json`);
    const csvPath = join(dir, `${base}-issues.csv`);
    writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    writeFileSync(
      csvPath,
      issuesToCsv({
        environment: report.environment,
        rows: [...report.rejected, ...report.positions],
      }),
    );
    printSummary(report, [jsonPath, csvPath], confirmCode, args.file);

    if (report.meta.aborted) return 1;
    const issues =
      report.rejected.length > 0 ||
      report.environment.issues.length > 0 ||
      report.positions.some((p) => p.issues.length > 0) ||
      (report.summary.written?.projectionFailures ?? 0) > 0;
    return issues ? 2 : 0;
  } finally {
    await prisma.$disconnect();
    lock?.release();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(
      `${TAG} FAILED:`,
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  });
