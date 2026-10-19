/**
 * The Driver's Village CLASSIFICATION import — reading a prepared
 * classification file: its header, its rows, and the rows of one code_1c
 * merged. Pure: no I/O. What may be applied to a stored position is decided
 * in drivers-village-classification.rules.ts.
 *
 * Only `code_1c`, `category_id`, `subcategory_id`, `vehicle_make` and
 * `vehicle_model` are read; price, quantity, name and every other column are
 * ignored, so prices and stock never change here.
 */
import { code1cIssue } from './drivers-village-code-key';
import { parseVehicle } from './drivers-village-row.parser';
import { vehicleLinks } from './drivers-village.planner';
import type {
  ImportIssue,
  VehicleLinks,
  VehicleSpec,
} from './drivers-village.types';

// ── Header ──────────────────────────────────────────────────────────────────

const CLASSIFICATION_HEADERS = {
  code1c: 'code_1c',
  categoryId: 'category_id',
  subcategoryId: 'subcategory_id',
  vehicleMake: 'vehicle_make',
  vehicleModel: 'vehicle_model',
} as const;

export type ClassificationField = keyof typeof CLASSIFICATION_HEADERS;

export interface ClassificationHeaders {
  index: Partial<Record<ClassificationField, number>>;
  /** Columns present but never read (price, quantity, name, …). */
  ignored: string[];
  errors: string[];
  /** Number of header cells: a row with more non-empty cells is shifted. */
  width: number;
}

export function mapClassificationHeaders(
  cells: string[],
): ClassificationHeaders {
  const map: ClassificationHeaders = {
    index: {},
    ignored: [],
    errors: [],
    width: cells.length,
  };
  const fields = Object.keys(CLASSIFICATION_HEADERS) as ClassificationField[];
  cells.forEach((cell, i) => {
    const header = cell.trim().toLowerCase();
    const field = fields.find((f) => CLASSIFICATION_HEADERS[f] === header);
    if (!field) {
      if (header) map.ignored.push(cell.trim());
      return;
    }
    if (map.index[field] !== undefined) {
      map.errors.push(`Column "${cell.trim()}" appears twice — keep one.`);
      return;
    }
    map.index[field] = i;
  });
  if (map.index.code1c === undefined)
    map.errors.push('Missing required column: code_1c');
  if (
    (['categoryId', 'subcategoryId', 'vehicleMake', 'vehicleModel'] as const)
      .map((f) => map.index[f])
      .every((i) => i === undefined)
  )
    map.errors.push(
      'No classification column: expected category_id / subcategory_id and/or vehicle_make + vehicle_model',
    );
  if (
    (map.index.vehicleMake === undefined) !==
    (map.index.vehicleModel === undefined)
  )
    map.errors.push(
      'vehicle_make and vehicle_model go together — one of them is missing',
    );
  return map;
}

// ── Rows ────────────────────────────────────────────────────────────────────

export interface CategoryCells {
  categoryId: string | null;
  subcategoryId: string | null;
}

export interface ClassificationRow {
  line: number;
  code1c: string | null;
  /** False when nothing of the row may be used (its code or its columns). */
  usable: boolean;
  category: CategoryCells;
  /** The vehicle cells; null when invalid (see issues) or not in the file. */
  vehicles: VehicleSpec | null;
  issues: ImportIssue[];
}

export function parseClassificationRow(
  cells: string[],
  line: number,
  headers: ClassificationHeaders,
): ClassificationRow {
  const get = (f: ClassificationField) => {
    const i = headers.index[f];
    return i === undefined ? '' : (cells[i] ?? '');
  };
  const code1c = get('code1c').trim() || null;
  const issues: ImportIssue[] = [];
  const add = (
    severity: ImportIssue['severity'],
    code: string,
    field: string | null,
    message: string,
  ) =>
    issues.push({ line, code1c, kind: 'data', severity, code, field, message });

  const codeIssue = code1cIssue(code1c);
  if (codeIssue) add('error', codeIssue.code, 'code1c', codeIssue.message);
  if (cells.slice(headers.width).some((c) => c.trim() !== ''))
    add(
      'error',
      'column_shift',
      null,
      `the row has ${cells.length} cells, the header ${headers.width}: a delimiter inside a value shifted the columns — the row is not read`,
    );
  const usable = issues.length === 0;
  const cell = (f: ClassificationField) => get(f).trim() || null;

  let vehicles: VehicleSpec | null = null;
  if (usable && headers.index.vehicleMake !== undefined) {
    // An invalid vehicle cell keeps the row's category usable: it only means
    // no vehicle of this row is applied.
    const parsed = parseVehicle(
      get('vehicleMake'),
      get('vehicleModel'),
      (code, field, message) =>
        add(
          'warning',
          code,
          field,
          `${message} — no vehicle of this row is applied`,
        ),
    );
    vehicles = parsed?.spec ?? null;
  }
  return {
    line,
    code1c,
    usable,
    category: {
      categoryId: cell('categoryId'),
      subcategoryId: cell('subcategoryId'),
    },
    vehicles,
    issues,
  };
}

/** What the usable rows of one code_1c say, merged. */
export interface ClassificationSource {
  code1c: string;
  lines: number[];
  /**
   * The category the rows give: null when none gives one, 'conflict' when
   * they give different ones (empty cells give none).
   */
  category: CategoryCells | 'conflict' | null;
  /** The distinct categories the rows give (for the report). */
  pairs: CategoryCells[];
  /** Every vehicle any row names, merged. */
  vehicles: VehicleLinks;
}

const pairKey = (c: CategoryCells) =>
  `${c.categoryId ?? ''} > ${c.subcategoryId ?? ''}`;

export function describeCells(c: CategoryCells): string {
  return `category_id "${c.categoryId ?? ''}", subcategory_id "${c.subcategoryId ?? ''}"`;
}

export function groupByCode(rows: ClassificationRow[]): ClassificationSource[] {
  const groups = new Map<string, ClassificationRow[]>();
  for (const r of rows)
    if (r.usable && r.code1c)
      groups.set(r.code1c, [...(groups.get(r.code1c) ?? []), r]);
  return [...groups].map(([code1c, group]) => {
    const pairs = new Map<string, CategoryCells>();
    for (const r of group)
      if (r.category.categoryId || r.category.subcategoryId)
        pairs.set(pairKey(r.category), r.category);
    const distinct = [...pairs.values()];
    return {
      code1c,
      lines: group.map((r) => r.line),
      category:
        distinct.length === 0
          ? null
          : distinct.length === 1
            ? distinct[0]
            : 'conflict',
      pairs: distinct,
      vehicles: vehicleLinks(
        group.flatMap((r) => (r.vehicles ? [{ vehicle: r.vehicles }] : [])),
      ),
    };
  });
}
