/**
 * Shape of the machine-readable import report (JSON) and its CSV rendering of
 * problem rows. The report never contains connection strings, credentials or
 * environment variables — only file metadata, counts and per-row outcomes.
 */
import type { NumberFormat } from './drivers-village-price';
import type {
  CodeKeyConflict,
  CodeKeyMatch,
  CodeKeyShared,
  DuplicateCode,
  ImportIssue,
  VehicleMapping,
} from './drivers-village.types';
import type { DelimiterName } from './tsv-reader';

export type RowOutcome =
  | 'create'
  | 'update'
  | 'unchanged'
  /**
   * Another row of the file has the same code_1c and supplies the position
   * (the highest valid price); nothing of this row is written.
   */
  | 'merged'
  /**
   * A valid row whose code_1c has no stored position of its own and whose
   * 8-digit key is ambiguous (see `keyConflicts`); nothing of it is written.
   */
  | 'conflict'
  /** The source row itself is invalid; nothing of it is written. */
  | 'rejected';

/** Where a planned price comes from: the cell, the rule, the stored value. */
export interface PriceTrace {
  /** The price cell as the file holds it. */
  source: string;
  /** True when the source was below 1000 (thousands) and was ×1000. */
  scaled: boolean;
  /** The stored price; null for a new position. */
  from: string | null;
  /** The normalized price the import writes. */
  to: string;
}

export interface RowReport {
  line: number;
  code1c: string | null;
  outcome: RowOutcome;
  /** Import-owned fields that change (update only). */
  changes: string[];
  price?: PriceTrace;
  /** `to: null` = not in the file (create → schema default 1; update → kept). */
  quantity?: { from: number | null; to: number | null };
  /** The part number written (code_1c) and the stored one (null when new). */
  partNumber?: { from: string | null; to: string };
  /** Real run only: what was actually done. */
  written?: 'created' | 'updated' | 'skipped_unchanged' | 'not_written';
  projected?: boolean;
  issues: ImportIssue[];
}

export interface VehicleMappingSummary extends VehicleMapping {
  rows: number;
}

export interface ImportReport {
  meta: {
    mode: 'dry-run' | 'import';
    file: string;
    fileSha256: string;
    bytes: number;
    encoding: string;
    encodingDetected: boolean;
    /** Detected from the header row; null when the file was not read. */
    delimiter: DelimiterName | null;
    /** How the export writes numbers — follows from the delimiter. */
    numberFormat: NumberFormat | null;
    catalogSellerId: string;
    sourceSystem: string;
    currency: 'UZS';
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    /** Set when a fatal problem stopped the run before or during writes. */
    aborted: boolean;
    abortReason: string | null;
  };
  headers: {
    columns: string[];
    mapped: Partial<Record<string, string>>;
    ignored: string[];
    /**
     * Known columns the import never reads: category_id, subcategory_id,
     * manufacturer_part_number, oem_numbers.
     */
    notImported: string[];
  };
  environment: {
    catalogSeller: { id: string; name: string } | null;
    linkedSellerId: number | null;
    linkedSellerStatus: string | null;
    /** TELEGRAM | BUSINESS — Driver's Village must be BUSINESS. */
    linkedSellerType: string | null;
    /** File-level environment problems (not source-data errors). */
    issues: ImportIssue[];
  };
  summary: {
    totalRows: number;
    validRows: number;
    rejectedRows: number;
    rowsToCreate: number;
    rowsToUpdate: number;
    rowsUnchanged: number;
    /** Planned updates whose price changes. */
    rowsWithPriceChange: number;
    /** Valid rows whose source price was in thousands (×1000). */
    rowsWithScaledPrice: number;
    /** New positions — all created without a category. */
    newWithoutCategory: number;
    /** Positions in the file that exist but are still unclassified. */
    existingWithoutCategory: number;
    /** Planned updates whose stored part number is replaced by code_1c. */
    rowsWithPartNumberChange: number;
    /** code_1c values on more than one row (each is ONE position). */
    duplicateSourceCodes: number;
    /** …of which a highest valid price was chosen (see `duplicates`). */
    duplicateCodesMaxPrice: number;
    /** Rows folded into another row of the same code_1c (outcome 'merged'). */
    rowsMerged: number;
    /** code_1c values with no valid price on any row: nothing written. */
    codesWithoutValidPrice: number;
    /** Rows that update a position stored under another code (8-digit key). */
    rowsMatchedByKey: number;
    /** 8-digit keys the import could not resolve (see `keyConflicts`). */
    keyConflicts: number;
    /** Valid rows not written because of such a key (outcome 'conflict'). */
    rowsInKeyConflict: number;
    /** New positions created although another code shares their key. */
    rowsToCreateWithSharedKey: number;
    dataErrors: number;
    dataWarnings: number;
    referenceErrors: number;
    referenceWarnings: number;
    lookAlikeGroups: number;
    positionsNotInFile: number;
    existingPositionsWithPhotos: number;
    /** Valid rows without a quantity (create → schema default 1; update → kept). */
    rowsWithoutQuantity: number;
    written: {
      created: number;
      updated: number;
      skippedUnchanged: number;
      projected: number;
      projectionFailures: number;
    } | null;
  };
  vehicles: {
    universalRows: number;
    makeWideRows: number;
    specificModelRows: number;
    multiModelRows: number;
    modelLinks: number;
    mappings: VehicleMappingSummary[];
    /**
     * Canonical make/model (model null = make-wide) with no same-named row in
     * this database's vehicle_makes / vehicle_models. The fit is still stored;
     * no garage vehicle matches it until the reference has that name.
     */
    notInBuyerReference: { make: string; model: string | null; rows: number }[];
  };
  /** Sample of the price rule at work: scaled and unscaled rows of the file. */
  prices: { examples: (PriceTrace & { line: number; code1c: string })[] };
  units: Record<string, number>;
  /** Every code_1c on more than one row: its rows and the price chosen. */
  duplicates: DuplicateCode[];
  /** Positions found by the 8-digit key: stored code → the file's code_1c. */
  keyMatches: CodeKeyMatch[];
  /** 8-digit keys left unresolved: their codes are not written. */
  keyConflicts: CodeKeyConflict[];
  /** New positions sharing an 8-digit key (warning code_key_shared). */
  keyShared: CodeKeyShared[];
  lookAlikes: { key: string; codes: string[] }[];
  positionsNotInFile: string[];
  projectionFailures: { code1c: string; stockId: number; error: string }[];
  rows: RowReport[];
}

const CSV_COLUMNS = [
  'line',
  'code_1c',
  'outcome',
  'kind',
  'severity',
  'code',
  'field',
  'message',
];

/** One CSV line per issue, for every row that has at least one issue. */
export function issuesToCsv(report: ImportReport): string {
  const lines = [CSV_COLUMNS.join(',')];
  const push = (row: RowReport | null, i: ImportIssue) =>
    lines.push(
      [
        i.line ?? '',
        i.code1c ?? '',
        row?.outcome ?? '',
        i.kind,
        i.severity,
        i.code,
        i.field ?? '',
        i.message,
      ]
        .map(csvCell)
        .join(','),
    );
  for (const i of report.environment.issues) push(null, i);
  for (const row of report.rows) for (const i of row.issues) push(row, i);
  return `${lines.join('\n')}\n`;
}

function csvCell(value: string | number): string {
  const s = String(value);
  // Neutralize spreadsheet formula injection, then quote per RFC 4180.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
