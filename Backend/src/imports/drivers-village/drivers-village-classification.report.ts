/**
 * Shape of the classification import's report (JSON) and how its counts are
 * derived. The report never contains connection strings, credentials or
 * environment variables — only file metadata, counts and per-position
 * decisions. The issues CSV is written with issuesToCsv
 * (drivers-village.report.ts).
 */
import { createHash } from 'crypto';
import { DRIVERS_VILLAGE_SOURCE_SYSTEM } from './drivers-village.constants';
import {
  describeCells,
  type CategoryCells,
  type ClassificationField,
} from './drivers-village-classification';
import type { CategoryAction } from './drivers-village-classification.rules';
import type { ImportIssue } from './drivers-village.types';
import type { DelimiterName } from './tsv-reader';

export interface ClassificationPositionReport {
  code1c: string;
  lines: number[];
  /** apply = something is written; not_found = no position has the code. */
  outcome: 'apply' | 'unchanged' | 'not_found';
  stockId: number | null;
  category: {
    action: CategoryAction;
    /** The category the position had (null = not classified). */
    existing: string | null;
    /** The file's cells (the first pair when its rows disagree). */
    file: CategoryCells | null;
    /** The category the plan writes, if any. */
    planned: string | null;
  };
  vehicles: { add: string[]; addMakes: string[]; clearUniversal: boolean };
  /** Fitment Studio bindings the catalog part has (never written here). */
  curatedBindings: number;
  /** Real run only. */
  written?: 'applied' | 'not_written';
  /** Real run only: false when the category changed while applying (kept). */
  categoryWritten?: boolean;
  projected?: boolean;
  issues: ImportIssue[];
}

export interface ClassificationReport {
  meta: {
    mode: 'dry-run' | 'apply';
    file: string;
    fileSha256: string;
    bytes: number;
    encoding: string;
    encodingDetected: boolean;
    delimiter: DelimiterName | null;
    catalogSellerId: string;
    sourceSystem: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    aborted: boolean;
    abortReason: string | null;
  };
  headers: {
    columns: string[];
    mapped: Partial<Record<ClassificationField, string>>;
    /** Present but never read (price, quantity, name, …). */
    ignored: string[];
  };
  environment: {
    catalogSeller: { id: string; name: string } | null;
    linkedSellerId: number | null;
    linkedSellerStatus: string | null;
    linkedSellerType: string | null;
    issues: ImportIssue[];
  };
  summary: {
    totalRows: number;
    /** Rows that cannot be used at all (their code_1c or columns). */
    rejectedRows: number;
    /** Distinct usable code_1c values. */
    codes: number;
    positionsFound: number;
    /** Codes with no stored position — never created here. */
    positionsNotFound: number;
    /** Category decisions over the found positions. */
    category: Record<CategoryAction, number>;
    positionsWithNewVehicles: number;
    modelLinksAdded: number;
    makeLinksAdded: number;
    universalCleared: number;
    positionsWithCuratedFitment: number;
    /** Found positions the plan writes something for. */
    positionsToApply: number;
    written: {
      positions: number;
      categoriesWritten: number;
      /** Category changed in Mator while applying: kept, not written. */
      categoriesKeptChanged: number;
      projected: number;
      projectionFailures: number;
    } | null;
  };
  /** The file's category problems, grouped: what to fix before applying. */
  categoryProblems: {
    code: string;
    file: CategoryCells;
    message: string;
    positions: number;
  }[];
  /** Vehicle cells that could not be read, grouped by reason. */
  vehicleProblems: { message: string; rows: number }[];
  positions: ClassificationPositionReport[];
  /** Rows that cannot be used at all. */
  rejected: {
    line: number;
    code1c: string | null;
    outcome: 'rejected';
    issues: ImportIssue[];
  }[];
  projectionFailures: { code1c: string; stockId: number; error: string }[];
}

const CATEGORY_PROBLEMS = new Set([
  'category_unknown',
  'category_inactive',
  'category_mismatch',
  'category_fallback',
  'category_conflict',
]);

/** Counts and grouped problems, from the planned positions. */
export function summarizeClassification(report: ClassificationReport): void {
  const s = report.summary;
  const problems = new Map<
    string,
    ClassificationReport['categoryProblems'][number]
  >();
  for (const p of report.positions) {
    if (p.outcome === 'not_found') {
      s.positionsNotFound += 1;
      continue;
    }
    s.positionsFound += 1;
    s.category[p.category.action] += 1;
    if (p.vehicles.add.length || p.vehicles.addMakes.length)
      s.positionsWithNewVehicles += 1;
    s.modelLinksAdded += p.vehicles.add.length;
    s.makeLinksAdded += p.vehicles.addMakes.length;
    if (p.vehicles.clearUniversal) s.universalCleared += 1;
    if (p.curatedBindings > 0) s.positionsWithCuratedFitment += 1;
    if (p.outcome === 'apply') s.positionsToApply += 1;
    for (const i of p.issues) {
      if (!CATEGORY_PROBLEMS.has(i.code) || !p.category.file) continue;
      const key = `${i.code}|${describeCells(p.category.file)}`;
      const agg = problems.get(key) ?? {
        code: i.code,
        file: p.category.file,
        message: i.message,
        positions: 0,
      };
      agg.positions += 1;
      problems.set(key, agg);
    }
  }
  report.categoryProblems = [...problems.values()].sort(
    (a, b) => b.positions - a.positions,
  );
}

export function groupMessages(
  issues: ImportIssue[],
): { message: string; rows: number }[] {
  const counts = new Map<string, number>();
  for (const i of issues)
    counts.set(i.message, (counts.get(i.message) ?? 0) + 1);
  return [...counts]
    .map(([message, rows]) => ({ message, rows }))
    .sort((a, b) => b.rows - a.rows);
}

export function emptyClassificationReport(
  dryRun: boolean,
  fileName: string,
  bytes: Uint8Array,
  catalogSellerId: string,
  startedAt: Date,
): ClassificationReport {
  return {
    meta: {
      mode: dryRun ? 'dry-run' : 'apply',
      file: fileName,
      fileSha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      encoding: '',
      encodingDetected: false,
      delimiter: null,
      catalogSellerId,
      sourceSystem: DRIVERS_VILLAGE_SOURCE_SYSTEM,
      startedAt: startedAt.toISOString(),
      finishedAt: '',
      durationMs: 0,
      aborted: false,
      abortReason: null,
    },
    headers: { columns: [], mapped: {}, ignored: [] },
    environment: {
      catalogSeller: null,
      linkedSellerId: null,
      linkedSellerStatus: null,
      linkedSellerType: null,
      issues: [],
    },
    summary: {
      totalRows: 0,
      rejectedRows: 0,
      codes: 0,
      positionsFound: 0,
      positionsNotFound: 0,
      category: {
        assign: 0,
        refine: 0,
        unchanged: 0,
        preserved: 0,
        invalid: 0,
        conflict: 0,
        none: 0,
      },
      positionsWithNewVehicles: 0,
      modelLinksAdded: 0,
      makeLinksAdded: 0,
      universalCleared: 0,
      positionsWithCuratedFitment: 0,
      positionsToApply: 0,
      written: null,
    },
    categoryProblems: [],
    vehicleProblems: [],
    positions: [],
    rejected: [],
    projectionFailures: [],
  };
}
