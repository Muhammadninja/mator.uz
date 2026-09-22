/**
 * Shape of the machine-readable import report (JSON) and its CSV rendering of
 * problem rows. The report never contains connection strings, credentials or
 * environment variables — only file metadata, counts and per-row outcomes.
 */
import type { ImportIssue, VehicleMapping } from './drivers-village.types';

export type RowOutcome =
  | 'create'
  | 'update'
  | 'unchanged'
  /** Valid source data, but this database lacks required reference data. */
  | 'blocked'
  /** The source row itself is invalid. */
  | 'rejected';

export interface RowReport {
  line: number;
  code1c: string | null;
  outcome: RowOutcome;
  /** Import-owned fields that change (update only). */
  changes: string[];
  price?: { from: string | null; to: string };
  quantity?: { from: number | null; to: number };
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
  };
  environment: {
    catalogSeller: { id: string; name: string } | null;
    linkedSellerId: number | null;
    linkedSellerStatus: string | null;
    /** TELEGRAM | BUSINESS — Driver's Village must be BUSINESS. */
    linkedSellerType: string | null;
    categoriesInDatabase: number;
    /** Category ids the file uses that this database does not have. */
    missingCategoryIds: string[];
    /** File-level environment problems (not source-data errors). */
    issues: ImportIssue[];
  };
  summary: {
    totalRows: number;
    validRows: number;
    rejectedRows: number;
    blockedRows: number;
    rowsToCreate: number;
    rowsToUpdate: number;
    rowsUnchanged: number;
    duplicateSourceCodes: number;
    dataErrors: number;
    dataWarnings: number;
    referenceErrors: number;
    referenceWarnings: number;
    lookAlikeGroups: number;
    positionsNotInFile: number;
    existingPositionsWithPhotos: number;
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
  };
  units: Record<string, number>;
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
