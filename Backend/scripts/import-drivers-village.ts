/**
 * Driver's Village 1C catalog import — CLI.
 *
 *   npm run import:drivers-village -- <file.txt> --dry-run     # plan + report, no writes
 *   npm run import:drivers-village -- <file.txt>               # real import
 *
 * Options:
 *   --dry-run               Parse, match and validate everything; write nothing.
 *   --encoding=<enc>        utf-8 | x-mac-cyrillic | windows-1251 (default: detected)
 *   --report-dir=<dir>      Where the JSON report and issues CSV go
 *                           (default: the input file's directory)
 *
 * Input: the 1C export saved from Excel as "Text (Tab delimited)". An .xlsx
 * workbook is not read directly (no spreadsheet dependency is installed) — use
 * Excel's File → Save As → Tab-delimited Text.
 *
 * The target dealer is fixed: catalog seller 'drivers-village' and the
 * supply-side seller linked to it (sellers.catalog_seller_id). The CLI never
 * creates either. Exit codes: 0 = clean, 2 = finished with rejected/blocked
 * rows or projection failures, 1 = aborted (nothing or only earlier batches
 * written — see the report).
 */
import { PrismaClient } from '@prisma/client';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, extname, join, resolve } from 'path';
import { CatalogProjectionService } from '../src/catalog/projection/catalog-projection.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { IMPORT_LIMITS } from '../src/imports/drivers-village/drivers-village.constants';
import { DriversVillageImportService } from '../src/imports/drivers-village/drivers-village-import.service';
import {
  issuesToCsv,
  type ImportReport,
} from '../src/imports/drivers-village/drivers-village.report';
import { PrismaDriversVillageStore } from '../src/imports/drivers-village/drivers-village.store';
import {
  isSupportedEncoding,
  SUPPORTED_ENCODINGS,
} from '../src/imports/drivers-village/tsv-reader';

interface CliArgs {
  file: string;
  dryRun: boolean;
  encoding?: (typeof SUPPORTED_ENCODINGS)[number];
  reportDir?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  const args: Partial<CliArgs> = { dryRun: false };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--encoding=')) {
      const enc = a.slice('--encoding='.length);
      if (!isSupportedEncoding(enc))
        fail(`--encoding must be one of: ${SUPPORTED_ENCODINGS.join(', ')}`);
      args.encoding = enc;
    } else if (a.startsWith('--report-dir='))
      args.reportDir = a.slice('--report-dir='.length);
    else if (a.startsWith('--')) fail(`Unknown option ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 1)
    fail(
      'Usage: npm run import:drivers-village -- <file.txt> [--dry-run] [--encoding=…] [--report-dir=…]',
    );
  return { ...args, file: resolve(positional[0]) } as CliArgs;
}

function fail(message: string): never {
  console.error(`[import:drivers-village] ${message}`);
  process.exit(1);
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

function printSummary(report: ImportReport, files: string[]): void {
  const s = report.summary;
  console.log(
    `\n[import:drivers-village] ${report.meta.mode.toUpperCase()} — ${report.meta.file} (${report.meta.encoding}${report.meta.encodingDetected ? ', detected' : ''})`,
  );
  console.table({
    'Total rows': s.totalRows,
    'Valid rows (source data)': s.validRows,
    'Rejected (data errors)': s.rejectedRows,
    'Blocked (reference data missing in this DB)': s.blockedRows,
    'Rows to create': s.rowsToCreate,
    'Rows to update': s.rowsToUpdate,
    'Rows unchanged': s.rowsUnchanged,
    'Duplicate code_1c values': s.duplicateSourceCodes,
    'Data errors / warnings': `${s.dataErrors} / ${s.dataWarnings}`,
    'Reference errors / warnings': `${s.referenceErrors} / ${s.referenceWarnings}`,
    'Look-alike product groups (not merged)': s.lookAlikeGroups,
    'DB positions not in this file (untouched)': s.positionsNotInFile,
  });
  const v = report.vehicles;
  console.log(
    `Vehicles: ${v.specificModelRows} specific-model rows (${v.multiModelRows} multi-model, ${v.modelLinks} links), ${v.makeWideRows} make-wide, ${v.universalRows} universal. Units: ${JSON.stringify(report.units)}`,
  );
  if (report.environment.issues.length) {
    console.log('\nEnvironment (this database, not the source file):');
    for (const i of report.environment.issues) console.log(`  • ${i.message}`);
  }
  if (report.environment.missingCategoryIds.length) {
    console.log(
      `  • Category ids used by the file but absent here: ${report.environment.missingCategoryIds.join(', ')}`,
    );
  }
  if (s.written)
    console.table({
      Created: s.written.created,
      Updated: s.written.updated,
      'Skipped (unchanged)': s.written.skippedUnchanged,
      Projected: s.written.projected,
      'Projection failures': s.written.projectionFailures,
    });
  if (report.meta.aborted)
    console.error(`\nABORTED: ${report.meta.abortReason}`);
  console.log(`\nReport: ${files.join('\n        ')}`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (['.xlsx', '.xls', '.xlsm'].includes(extname(args.file).toLowerCase())) {
    fail(
      'Excel workbooks are not read directly. In Excel use File → Save As → "Tab-delimited Text (.txt)" and pass that file.',
    );
  }
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

  console.log(
    `[import:drivers-village] mode=${args.dryRun ? 'dry-run' : 'IMPORT'} database=${describeDatabase()}`,
  );
  const prisma = new PrismaClient();
  try {
    const store = new PrismaDriversVillageStore(prisma);
    const projection = new CatalogProjectionService(
      prisma as unknown as PrismaService,
    );
    const service = new DriversVillageImportService(store, projection, (m) =>
      console.log(`[import:drivers-village] ${m}`),
    );
    const report = await service.run(
      readFileSync(args.file),
      basename(args.file),
      {
        dryRun: args.dryRun,
        encoding: args.encoding,
      },
    );

    const dir = resolve(args.reportDir ?? dirname(args.file));
    mkdirSync(dir, { recursive: true });
    const stamp = report.meta.startedAt.replace(/[:.]/g, '-');
    const jsonPath = join(
      dir,
      `drivers-village-${report.meta.mode}-${stamp}.json`,
    );
    const csvPath = join(
      dir,
      `drivers-village-${report.meta.mode}-${stamp}-issues.csv`,
    );
    writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    writeFileSync(csvPath, issuesToCsv(report));
    printSummary(report, [jsonPath, csvPath]);

    if (report.meta.aborted) return 1;
    const s = report.summary;
    return s.rejectedRows || s.blockedRows || s.written?.projectionFailures
      ? 2
      : 0;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(
      '[import:drivers-village] FAILED:',
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  });
