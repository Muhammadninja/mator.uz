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
 * Input: 1C's ";"-delimited export (dv_parts_<date>.txt, numbers "1,234.56")
 * or the file saved from Excel as "Text (Tab delimited)" (numbers "1 234,56");
 * the delimiter is detected from the header row. An .xlsx workbook is not
 * read directly (no spreadsheet dependency is installed) — use Excel's
 * File → Save As → Tab-delimited Text.
 *
 * The target dealer is fixed: catalog seller 'drivers-village' and the
 * supply-side seller linked to it (sellers.catalog_seller_id). The CLI never
 * creates either. Prices below 1000 are in thousands and are ×1000 (see
 * drivers-village-price.ts); categories are never imported. code_1c is the
 * part number (the file's manufacturer_part_number / oem_numbers are never
 * read), and a code_1c on several rows is one position at the highest valid
 * price of those rows. A real import holds the host-wide import lock
 * (src/imports/drivers-village/import-lock.ts, DV_IMPORT_LOCK_FILE), so it
 * never overlaps another one — manual or started by the Telegram ingest.
 * Exit codes:
 * 0 = clean, 2 = finished with rejected rows, 8-digit key conflicts or
 * projection failures,
 * 1 = aborted (nothing or only earlier batches written — see the report),
 * 3 = another import is running; nothing was done.
 */
import { PrismaClient } from '@prisma/client';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, extname, join, resolve } from 'path';
import { CatalogProjectionService } from '../src/catalog/projection/catalog-projection.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  acquireLock,
  importLockPath,
  LOCK_BUSY_EXIT_CODE,
  LockBusyError,
  type LockHandle,
} from '../src/imports/drivers-village/import-lock';
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

/** How many per-code examples the console shows; the JSON report has all. */
const SHOWN = 15;

function printSummary(report: ImportReport, files: string[]): void {
  const s = report.summary;
  console.log(
    `\n[import:drivers-village] ${report.meta.mode.toUpperCase()} — ${report.meta.file} (${report.meta.encoding}${report.meta.encodingDetected ? ', detected' : ''}; ${report.meta.delimiter ?? 'unknown'}-delimited, numbers ${report.meta.numberFormat ?? 'unknown'})`,
  );
  console.table({
    'Total rows': s.totalRows,
    'Valid rows (source data)': s.validRows,
    'Rejected (data errors; stored values untouched)': s.rejectedRows,
    'Rows to create': s.rowsToCreate,
    'Rows to update': s.rowsToUpdate,
    'Rows unchanged': s.rowsUnchanged,
    'Updates with a price change': s.rowsWithPriceChange,
    'Prices in thousands (×1000)': s.rowsWithScaledPrice,
    'New without category (classify in admin)': s.newWithoutCategory,
    'Existing still without category': s.existingWithoutCategory,
    'Part numbers corrected from code_1c': s.rowsWithPartNumberChange,
    'Duplicate code_1c values (one position each)': s.duplicateSourceCodes,
    'Duplicates at their highest valid price': s.duplicateCodesMaxPrice,
    'Rows merged into another row of the same code_1c': s.rowsMerged,
    'Codes without a valid price (nothing written)': s.codesWithoutValidPrice,
    'Matched by the 8-digit key (code_1c changed)': s.rowsMatchedByKey,
    'Rows in an 8-digit key conflict (nothing written)': s.rowsInKeyConflict,
    'New positions sharing an 8-digit key (separate, not merged)':
      s.rowsToCreateWithSharedKey,
    'Data errors / warnings': `${s.dataErrors} / ${s.dataWarnings}`,
    'Reference errors / warnings': `${s.referenceErrors} / ${s.referenceWarnings}`,
    'Look-alike product groups (not merged)': s.lookAlikeGroups,
    'DB positions not in this file (untouched)': s.positionsNotInFile,
    'Rows without quantity (new → 1, existing → kept)': s.rowsWithoutQuantity,
  });
  const v = report.vehicles;
  console.log(
    `Vehicles: ${v.specificModelRows} specific-model rows (${v.multiModelRows} multi-model, ${v.modelLinks} links), ${v.makeWideRows} make-wide, ${v.universalRows} universal. Units: ${JSON.stringify(report.units)}`,
  );
  if (v.notInBuyerReference.length) {
    console.log(
      `Fits with no same-named vehicle_makes / vehicle_models row (stored, but no garage vehicle matches yet): ${v.notInBuyerReference
        .map(
          (f) =>
            `${f.make}${f.model ? ` ${f.model}` : ' (make-wide)'} ×${f.rows}`,
        )
        .join(', ')}`,
    );
  }
  if (report.prices.examples.length) {
    console.log('\nPrice rule (source < 1000 → ×1000, otherwise as is):');
    for (const e of report.prices.examples)
      console.log(
        `  line ${e.line} ${e.code1c}: "${e.source}" → ${e.to}${e.scaled ? ' (×1000)' : ''}${e.from === null ? ' (new)' : ` (stored ${e.from})`}`,
      );
  }
  const corrected = report.rows.filter(
    (r) => r.outcome === 'update' && r.changes.includes('part_number'),
  );
  if (corrected.length) {
    console.log('\nPart number replaced by code_1c (stored → new):');
    for (const r of corrected.slice(0, SHOWN))
      console.log(
        `  line ${r.line}: "${r.partNumber?.from ?? ''}" → "${r.partNumber?.to}"`,
      );
    if (corrected.length > SHOWN)
      console.log(
        `  … and ${corrected.length - SHOWN} more in the JSON report`,
      );
  }
  const priced = report.duplicates.filter((d) => d.priceUzs !== null);
  if (priced.length) {
    console.log(
      '\nRepeated code_1c — one position at the highest valid price:',
    );
    for (const d of priced.slice(0, SHOWN))
      console.log(
        `  ${d.code1c}: ${d.rows} rows (lines ${d.lines.join(', ')}) → ${d.priceUzs} UZS from line ${d.chosenLine}${d.differs.length ? `; rows differ in ${d.differs.join(', ')}` : ''}`,
      );
    if (priced.length > SHOWN)
      console.log(
        `  … and ${priced.length - SHOWN} more in the JSON report (duplicates)`,
      );
  }
  if (report.keyMatches.length) {
    console.log(
      '\nFound by the 8-digit key — the stored position takes the new code_1c:',
    );
    for (const m of report.keyMatches.slice(0, SHOWN))
      console.log(`  line ${m.line}: "${m.storedCode}" → "${m.code1c}"`);
    if (report.keyMatches.length > SHOWN)
      console.log(
        `  … and ${report.keyMatches.length - SHOWN} more in the JSON report (keyMatches)`,
      );
  }
  if (report.keyConflicts.length) {
    console.log(
      '\n8-digit key conflicts — these codes are not written, stored positions stay:',
    );
    for (const c of report.keyConflicts.slice(0, SHOWN))
      console.log(
        `  ${c.key}: file ${c.codes.join(', ')} (lines ${c.lines.join(', ')}); stored ${c.storedCodes.join(', ')}`,
      );
    if (report.keyConflicts.length > SHOWN)
      console.log(
        `  … and ${report.keyConflicts.length - SHOWN} more in the JSON report (keyConflicts)`,
      );
  }
  if (report.keyShared.length) {
    console.log(
      `\nShared 8-digit key — ${report.summary.rowsToCreateWithSharedKey} new position(s) of their own, nothing merged (code_key_shared):`,
    );
    for (const k of report.keyShared.slice(0, SHOWN))
      console.log(
        `  line ${k.line}: "${k.code1c}" shares ${k.key} with ${[...k.fileCodes, ...k.storedCodes.map((c) => `${c} (stored)`)].join(', ')}`,
      );
    if (report.keyShared.length > SHOWN)
      console.log(
        `  … and ${report.keyShared.length - SHOWN} more in the JSON report (keyShared)`,
      );
  }
  if (report.headers.notImported.length) {
    console.log(
      `\nNot imported (categories are assigned in Mator; the part number is code_1c): ${report.headers.notImported.join(', ')}`,
    );
  }
  if (report.environment.issues.length) {
    console.log('\nEnvironment (this database, not the source file):');
    for (const i of report.environment.issues) console.log(`  • ${i.message}`);
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

  // One real import at a time (a dry run writes nothing and takes no lock).
  let lock: LockHandle | null = null;
  if (!args.dryRun) {
    try {
      lock = acquireLock(importLockPath(), {
        label: 'import:drivers-village',
      });
    } catch (error) {
      if (!(error instanceof LockBusyError)) throw error;
      console.error(
        `[import:drivers-village] Another import is running — ${error.message}. Nothing was done.`,
      );
      return LOCK_BUSY_EXIT_CODE;
    }
  }

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
    return s.rejectedRows ||
      s.rowsInKeyConflict ||
      s.written?.projectionFailures
      ? 2
      : 0;
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
      '[import:drivers-village] FAILED:',
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  });
