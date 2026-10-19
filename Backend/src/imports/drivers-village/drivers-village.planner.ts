/**
 * Pure planning steps of the Driver's Village import: fold the rows of one
 * code_1c into one position, build the write, diff it against what is already
 * stored, and flag what an operator should review. No I/O.
 */
import { Prisma } from '@prisma/client';
import { CatalogProjectionService } from '../../catalog/projection/catalog-projection.service';
import { PRICE_JUMP_REVIEW_RATIO } from './drivers-village.constants';
import type {
  DuplicateCode,
  ExistingPosition,
  ImportIssue,
  IssueSeverity,
  ParsedRow,
  PositionWrite,
  VehicleReference,
  VehicleSpec,
} from './drivers-village.types';

/** One source line as the parser left it. */
export interface SourceLine {
  line: number;
  code1c: string | null;
  /** Null when the parser rejected the line. */
  row: ParsedRow | null;
  issues: ImportIssue[];
}

/** What resolveDuplicateCodes decided for one line of a shared code_1c. */
export interface LinePatch {
  /** 'merged' = folded into the chosen line; absent = outcome unchanged. */
  outcome?: 'merged';
  /** The line's complete issue list after the decision. */
  issues: ImportIssue[];
}

export interface CodeResolution {
  /** The rows to plan: one per code_1c that has an importable row. */
  positions: ParsedRow[];
  /** Every code_1c on more than one row, in order of first appearance. */
  duplicates: DuplicateCode[];
  /** New outcome / issues for the lines of a shared code_1c. */
  patches: Map<number, LinePatch>;
  /** code_1c values on whose rows no price is valid: nothing is written. */
  codesWithoutValidPrice: string[];
}

const isPriceError = (i: ImportIssue) =>
  i.code === 'invalid_price' && i.severity === 'error';

/** Import-owned fields besides the price that duplicate rows may disagree on. */
const COMPARED_FIELDS: [string, (r: ParsedRow) => string][] = [
  ['name', (r) => r.name],
  ['quantity', (r) => String(r.quantity)],
  ['unit', (r) => r.unit],
  ['gm_number', (r) => r.gmNumber ?? ''],
  ['vehicles', (r) => vehicleKey(r.vehicle)],
];

/**
 * One position per code_1c. A code on several rows (the export lists a part
 * once per batch, at different prices) is ONE position, written once at the
 * HIGHEST valid price among its rows — an exact Decimal comparison of the
 * normalized prices, no rounding; on a tie the first row wins — together with
 * the other fields of that same row. Only rows that pass every data check
 * compete: an invalid price never wins, and a row rejected for anything else
 * never feeds the database. The other rows are 'merged' (reported, not
 * written); a row whose only error is its price is merged too, the error
 * downgraded to a warning. When no row of a code has a valid price, nothing is
 * written for it, so a stored price is never replaced by zero or an invalid
 * value. Pure: no I/O.
 */
export function resolveDuplicateCodes(lines: SourceLine[]): CodeResolution {
  const byCode = new Map<string, SourceLine[]>();
  for (const l of lines)
    if (l.code1c) byCode.set(l.code1c, [...(byCode.get(l.code1c) ?? []), l]);

  const out: CodeResolution = {
    positions: [],
    duplicates: [],
    patches: new Map(),
    codesWithoutValidPrice: [],
  };
  for (const [code1c, group] of byCode) {
    const valid = group.flatMap((l) => (l.row ? [l.row] : []));
    const chosen = highestPrice(valid);
    const priced = group.some((l) => l.row || !l.issues.some(isPriceError));
    if (chosen) out.positions.push(chosen);
    if (!priced) out.codesWithoutValidPrice.push(code1c);
    if (group.length === 1) continue;

    const where = `code_1c "${code1c}" is on lines ${group.map((l) => l.line).join(', ')}`;
    const issue = (
      l: SourceLine,
      severity: IssueSeverity,
      code: string,
      message: string,
      field: string = code === 'no_valid_price' ? 'price' : 'code1c',
    ): ImportIssue => ({
      line: l.line,
      code1c,
      kind: 'data',
      severity,
      code,
      field,
      message,
    });
    const differs = COMPARED_FIELDS.filter(
      ([, value]) => new Set(valid.map(value)).size > 1,
    ).map(([name]) => name);
    // Differences that may mean different goods, batches or warehouses are
    // reported on the chosen row on their own, so they can be filtered for
    // review. The behaviour stays the rule: every field from the chosen row.
    const chosenLine = group.find((l) => chosen && l.row === chosen);
    const quantities = [
      ...new Set(
        valid.map((r) => (r.quantity === null ? 'none' : `${r.quantity}`)),
      ),
    ];
    const review: ImportIssue[] =
      chosen && chosenLine
        ? [
            ...(differs.includes('quantity')
              ? [
                  issue(
                    chosenLine,
                    'warning',
                    'duplicate_quantities_differ',
                    `${where} with different quantities (${quantities.join(', ')}) — possibly different batches or warehouses. Line ${chosen.line} has the highest valid price, so its quantity (${chosen.quantity ?? 'none'}) is imported with that price; quantities are never added up.`,
                    'quantity',
                  ),
                ]
              : []),
            ...(differs.includes('name')
              ? [
                  issue(
                    chosenLine,
                    'warning',
                    'duplicate_names_differ',
                    `${where} under different names — check that they are one part. The name of line ${chosen.line} is imported.`,
                    'name',
                  ),
                ]
              : []),
          ]
        : [];
    out.duplicates.push({
      code1c,
      rows: group.length,
      lines: group.map((l) => l.line),
      chosenLine: chosen?.line ?? null,
      priceUzs: chosen?.priceUzs ?? null,
      differs,
    });

    for (const l of group) {
      if (!chosen) {
        out.patches.set(l.line, {
          issues: [
            ...l.issues,
            priced
              ? issue(
                  l,
                  'warning',
                  'duplicate_code_1c',
                  `${where}; no row passes every check, so nothing is written for it`,
                )
              : issue(
                  l,
                  'error',
                  'no_valid_price',
                  `${where}; none has a valid positive price, so nothing is written for it — a stored price stays as it is`,
                ),
          ],
        });
        continue;
      }
      const note =
        `${where} — one position at the highest valid price, ${chosen.priceUzs} UZS from line ${chosen.line}` +
        (differs.length
          ? `, with that line's ${differs.join(', ')} (the rows differ)`
          : '') +
        (l.row === chosen ? '' : '; this row is not imported separately');
      const priceOnly =
        !l.row &&
        l.issues.every((i) => i.severity !== 'error' || isPriceError(i));
      out.patches.set(l.line, {
        outcome:
          (l.row && l.row !== chosen) || priceOnly ? 'merged' : undefined,
        issues: [
          ...(priceOnly
            ? l.issues.map((i) =>
                isPriceError(i)
                  ? {
                      ...i,
                      severity: 'warning' as const,
                      message: `${i.message} — ignored: line ${chosen.line} has the highest valid price`,
                    }
                  : i,
              )
            : l.issues),
          issue(l, 'warning', 'duplicate_code_1c', note),
          ...(l === chosenLine ? review : []),
        ],
      });
    }
  }
  return out;
}

const ROW_NUMBER_MIN_ROWS = 10;

/**
 * A file whose code_1c column holds ROW NUMBERS instead of part numbers (an
 * export with code_1c = 1, 2, 3 … in any order): at least half of its rows,
 * and at least ROW_NUMBER_MIN_ROWS, carry distinct whole numbers no larger
 * than the number of rows. Part numbers do not look like that: in the
 * dv_parts exports profiled on 2026-10-18 at most 9 of ~4 300 rows hold such
 * a number (codes such as 294 or 650), and none follows its predecessor + 1.
 * Long numeric part numbers (8, 10, 13 digits) can never count — they exceed
 * the row count — so numeric codes as such are never suspect.
 */
export function detectRowNumberCodes(
  codes: (string | null)[],
): { rows: number; distinct: number; min: number; max: number } | null {
  const rows = codes.length;
  if (rows < ROW_NUMBER_MIN_ROWS) return null;
  const values = new Set<number>();
  for (const c of codes)
    if (c && /^[1-9]\d{0,8}$/.test(c) && Number(c) <= rows)
      values.add(Number(c));
  if (values.size < Math.max(ROW_NUMBER_MIN_ROWS, rows / 2)) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  return { rows, distinct: values.size, min, max };
}

/** The row with the highest price; rows in file order, so a tie keeps the first. */
function highestPrice(rows: ParsedRow[]): ParsedRow | null {
  let best: ParsedRow | null = null;
  for (const r of rows)
    if (!best || new Prisma.Decimal(r.priceUzs).gt(best.priceUzs)) best = r;
  return best;
}

/** A vehicle spec as one comparable string; model order does not matter. */
function vehicleKey(v: VehicleSpec): string {
  if (v.kind === 'universal') return '*';
  if (v.kind === 'make') return `${v.make}|*`;
  return `${v.make}|${[...v.models].sort().join(',')}`;
}

/**
 * The write for one row: import-owned fields only. No category — a new
 * position is created unclassified and an existing one keeps its own.
 * From the 8-digit key (drivers-village-code-key.ts): `previousCode1c` — the
 * stored code_1c of the position a key match updates; `searchKey` — the key,
 * added to the OEM index after the code's own entry (never twice).
 */
export function buildWrite(
  row: ParsedRow,
  key: { previousCode1c?: string; searchKey?: string } = {},
): PositionWrite {
  const oemNumbers =
    key.searchKey && !row.oemNumbers.includes(key.searchKey)
      ? [...row.oemNumbers, key.searchKey]
      : row.oemNumbers;
  return {
    code1c: row.code1c,
    ...(key.previousCode1c ? { previousCode1c: key.previousCode1c } : {}),
    priceUzs: row.priceUzs,
    quantity: row.quantity,
    unit: row.unit,
    product: {
      title: row.name,
      gmNumbers: row.gmNumber ? [row.gmNumber] : [],
      sourcePartNumber: row.sourcePartNumber,
      oemNumbers,
      isUniversal: row.vehicle.kind === 'universal',
    },
    models:
      row.vehicle.kind === 'models'
        ? row.vehicle.models.map((model) => ({
            make: (row.vehicle as { make: string }).make,
            model,
          }))
        : [],
    make: row.vehicle.kind === 'make' ? row.vehicle.make : null,
  };
}

/** Import-owned fields whose stored value differs from the planned write. */
export function diffPosition(w: PositionWrite, e: ExistingPosition): string[] {
  const changes: string[] = [];
  const decimalDiffers = (a: string, b: string) =>
    !new Prisma.Decimal(a).eq(new Prisma.Decimal(b));
  const listDiffers = (a: string[], b: string[]) =>
    a.length !== b.length || a.some((v, i) => v !== b[i]);

  if (decimalDiffers(w.priceUzs, e.priceUzs)) changes.push('price');
  // No quantity in the file leaves the stored count alone — never a change.
  if (w.quantity !== null && w.quantity !== e.quantity)
    changes.push('quantity');
  if (w.unit !== e.unit) changes.push('unit');
  if (w.product.title !== e.title) changes.push('name');
  if (listDiffers(w.product.gmNumbers, e.gmNumbers)) changes.push('gm_number');
  // Only after a match by the 8-digit key: the position takes the new code.
  if (w.code1c !== e.sourceCode) changes.push('source_code');
  if (w.product.sourcePartNumber !== e.sourcePartNumber)
    changes.push('part_number');
  if (listDiffers(w.product.oemNumbers, e.oemNumbers))
    changes.push('oem_numbers');
  const models = w.models.map((m) => `${m.make}|${m.model}`).sort();
  const makes = w.make ? [w.make] : [];
  if (
    w.product.isUniversal !== e.isUniversal ||
    listDiffers(models, e.models) ||
    listDiffers(makes, e.makes)
  )
    changes.push('vehicles');
  return changes;
}

/**
 * Whether a position still waits for manual classification: no category at
 * all, or the projection's fallback bucket every new position lands in.
 */
export function isUnclassified(categoryId: string | null): boolean {
  return (
    !categoryId || categoryId === CatalogProjectionService.UNCATEGORIZED_ID
  );
}

/**
 * A price change of PRICE_JUMP_REVIEW_RATIO× or more in either direction — a
 * price read in the wrong scale changes by exactly ×1000. Flagged, never
 * blocked: the very first scaled import of a position stored unscaled is
 * such a jump, and it is the correction.
 */
export function isPriceJump(stored: string, planned: string): boolean {
  const a = new Prisma.Decimal(stored);
  const b = new Prisma.Decimal(planned);
  if (a.lte(0) || b.lte(0)) return !a.eq(b);
  const [low, high] = a.lt(b) ? [a, b] : [b, a];
  return high.div(low).gte(PRICE_JUMP_REVIEW_RATIO);
}

export interface FitNotInReference {
  make: string;
  /** Null for a make-wide fit. */
  model: string | null;
  rows: number;
}

/**
 * Fits whose canonical name this database's buyer vehicle reference does not
 * have. The garage filter matches catalog_part_fits / catalog_part_make_fits by
 * make and model NAME (case-insensitive), so such a fit is stored but matches
 * no garage vehicle until vehicle_makes / vehicle_models carry that name. A
 * reference warning, never a block: the mapping is right, the reference lags.
 */
export function findFitsNotInReference(
  rows: ParsedRow[],
  reference: VehicleReference,
): { missing: FitNotInReference[]; issues: ImportIssue[] } {
  const makes = new Set(reference.makes.map((m) => m.toLowerCase()));
  const models = new Set(reference.models.map((m) => m.toLowerCase()));
  const missing = new Map<string, FitNotInReference>();
  const issues: ImportIssue[] = [];
  for (const row of rows) {
    const v = row.vehicle;
    const fits =
      v.kind === 'models'
        ? v.models.map((model) => ({ make: v.make, model }))
        : v.kind === 'make'
          ? [{ make: v.make, model: null }]
          : [];
    for (const f of fits) {
      const known =
        f.model === null
          ? makes.has(f.make.toLowerCase())
          : models.has(`${f.make}|${f.model}`.toLowerCase());
      if (known) continue;
      const key = `${f.make}|${f.model ?? ''}`;
      const agg = missing.get(key) ?? { ...f, rows: 0 };
      agg.rows += 1;
      missing.set(key, agg);
      issues.push({
        line: row.line,
        code1c: row.code1c,
        kind: 'reference',
        severity: 'warning',
        code: 'vehicle_not_in_reference',
        field: f.model === null ? 'vehicleMake' : 'vehicleModel',
        message: `"${f.make}${f.model === null ? '' : ` ${f.model}`}" has no same-named row in vehicle_makes / vehicle_models — the fit is stored, but no garage vehicle matches it yet`,
      });
    }
  }
  return {
    missing: [...missing.values()].sort(
      (a, b) =>
        b.rows - a.rows ||
        `${a.make}|${a.model ?? ''}`.localeCompare(
          `${b.make}|${b.model ?? ''}`,
        ),
    ),
    issues,
  };
}

/**
 * Rows that look like the same product under different code_1c values (same
 * normalized name, vehicle and OEM set). Reported for review only — separate
 * 1C positions are separate stock (different brand, batch or price) and are
 * NEVER merged by the importer.
 */
export function findLookAlikes(
  rows: ParsedRow[],
): { key: string; codes: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    const key = `${r.name.toLowerCase()} :: ${vehicleKey(r.vehicle)} :: ${[...r.oemNumbers].sort().join(' ')}`;
    groups.set(key, [...(groups.get(key) ?? []), r.code1c]);
  }
  return [...groups]
    .filter(([, codes]) => codes.length > 1)
    .map(([key, codes]) => ({ key, codes }));
}
