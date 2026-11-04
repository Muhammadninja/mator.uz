/**
 * Turns the cells of one Driver's Village 1C row into a validated ParsedRow, or
 * reports why it cannot be imported. Pure: no I/O, no database.
 *
 * Every check here is about the SOURCE DATA. Whether a fit names a vehicle the
 * database's buyer reference knows is a separate, environment-level question
 * answered by the planner (reported with kind 'reference').
 */
import { Prisma } from '@prisma/client';
import { normalizeOem } from '../../common/normalize-oem.util';
import { code1cIssue } from './drivers-village-code-key';
import {
  FIELD_LIMITS,
  MAX_QUANTITY,
  PRICE_IN_THOUSANDS_BELOW,
} from './drivers-village.constants';
import {
  normalizeSourcePrice,
  parseDecimal,
  type NumberFormat,
} from './drivers-village-price';
import {
  normalizeVehicleCode,
  resolveMake,
  resolveModel,
} from './drivers-village-vehicle.mapper';
import type {
  ImportIssue,
  ParsedRow,
  StockUnit,
  VehicleMapping,
  VehicleSpec,
} from './drivers-village.types';

// ── Header mapping ──────────────────────────────────────────────────────────

/** Logical fields and the header names that feed them (lowercase, exact). */
const HEADER_ALIASES = {
  code1c: ['code_1c'],
  name: ['name'],
  quantity: ['quantity'],
  unit: ['unit'],
  price: ['price'],
  vehicleMake: ['vehicle_make'],
  vehicleModel: ['vehicle_model'],
  gmNumber: ['gm_number'],
} as const;

export type Field = keyof typeof HEADER_ALIASES;

// `quantity` is optional: the current export has no such column (see parseRow).
const REQUIRED: Field[] = [
  'code1c',
  'name',
  'unit',
  'price',
  'vehicleMake',
  'vehicleModel',
];

/**
 * Columns an export may carry that the import deliberately never reads.
 * Reported separately from unknown columns so nobody expects them to apply.
 *   • category_id, subcategory_id — the price/stock sync never classifies: a
 *     new position is created without a category, an existing one keeps
 *     whatever category it has. A prepared classification file is applied by
 *     the separate, explicitly run classification import
 *     (drivers-village-classification.service.ts).
 *   • manufacturer_part_number, oem_numbers — the manufacturer part number is
 *     code_1c (business rule, 2026-10-18). These cells hold unreliable values
 *     (brand and model names among them), so they never reach the database.
 */
const NOT_IMPORTED: readonly string[] = [
  'category_id',
  'subcategory_id',
  'manufacturer_part_number',
  'oem_numbers',
];

export interface HeaderMap {
  index: Partial<Record<Field, number>>;
  /** Header text actually used for each field. */
  source: Partial<Record<Field, string>>;
  ignored: string[];
  /** Known columns the import never reads (NOT_IMPORTED). */
  notImported: string[];
  errors: string[];
  /** Number of header cells: a row with more non-empty cells is shifted. */
  width: number;
}

export function mapHeaders(cells: string[]): HeaderMap {
  const map: HeaderMap = {
    index: {},
    source: {},
    ignored: [],
    notImported: [],
    errors: [],
    width: cells.length,
  };
  const normalized = cells.map((c) => c.trim().toLowerCase());

  normalized.forEach((header, i) => {
    const field = (Object.keys(HEADER_ALIASES) as Field[]).find((f) =>
      (HEADER_ALIASES[f] as readonly string[]).includes(header),
    );
    if (!field) {
      if (NOT_IMPORTED.includes(header)) map.notImported.push(cells[i].trim());
      else if (header) map.ignored.push(cells[i].trim());
      return;
    }
    if (map.index[field] !== undefined) {
      map.errors.push(
        `Columns "${map.source[field]}" and "${cells[i].trim()}" both map to ${field} — keep one.`,
      );
      return;
    }
    map.index[field] = i;
    map.source[field] = cells[i].trim();
  });

  for (const field of REQUIRED) {
    if (map.index[field] === undefined) {
      map.errors.push(
        `Missing required column: ${HEADER_ALIASES[field].join(' / ')}`,
      );
    }
  }
  return map;
}

// ── Row parsing ─────────────────────────────────────────────────────────────

export interface RowResult {
  row: ParsedRow | null;
  /** Raw code_1c (trimmed) even when the row is rejected — for reporting. */
  code1c: string | null;
  issues: ImportIssue[];
}

const UNIT_CODES: Readonly<Record<string, StockUnit>> = {
  'шт.': 'PCS',
  шт: 'PCS',
  // "штук" (pieces, genitive plural): the 1C export's spelling on ~17 rows.
  штук: 'PCS',
  'л.': 'L',
  л: 'L',
  литр: 'L',
};

/**
 * `numberFormat` is the export's (see NumberFormat): the price and the
 * quantity cells are read in it, never guessed per cell.
 */
export function parseRow(
  cells: string[],
  line: number,
  headers: HeaderMap,
  numberFormat: NumberFormat = 'decimal-comma',
): RowResult {
  const get = (f: Field): string => {
    const i = headers.index[f];
    return i === undefined ? '' : (cells[i] ?? '');
  };
  const issues: ImportIssue[] = [];
  const code1c = get('code1c').trim() || null;
  const err = (code: string, field: Field | null, message: string) =>
    issues.push({
      line,
      code1c,
      kind: 'data',
      severity: 'error',
      code,
      field,
      message,
    });
  const warn = (code: string, field: Field | null, message: string) =>
    issues.push({
      line,
      code1c,
      kind: 'data',
      severity: 'warning',
      code,
      field,
      message,
    });

  // code_1c — the position's identity in 1C and its manufacturer part number,
  // stored verbatim (trimmed) as both. The rule is shared with the Telegram
  // photo flow, so a caption can name exactly the codes stored here.
  const codeIssue = code1cIssue(code1c);
  if (codeIssue) err(codeIssue.code, 'code1c', codeIssue.message);
  // These are the row's first checks, so any issue so far is about code_1c.
  const codeValid = issues.length === 0;

  // A row with more non-empty cells than the header: a delimiter inside an
  // unquoted value moved every later cell, so no cell can be trusted.
  if (cells.slice(headers.width).some((c) => c.trim() !== ''))
    err(
      'column_shift',
      null,
      `the row has ${cells.length} cells, the header ${headers.width}: a delimiter inside a value shifted the columns — the row is not read`,
    );

  // name — whitespace-normalized; the text itself is never altered.
  const name = get('name').trim().replace(/\s+/g, ' ');
  if (!name) err('empty_name', 'name', 'name is empty');
  else if (name.length > FIELD_LIMITS.title)
    err(
      'name_too_long',
      'name',
      `name longer than ${FIELD_LIMITS.title} characters`,
    );
  else if (/[A-Za-z][А-Яа-яЁё]|[А-Яа-яЁё][A-Za-z]/.test(name))
    warn(
      'mixed_script_name',
      'name',
      `name "${name}" mixes Latin and Cyrillic letters inside a word (kept as-is)`,
    );

  // PRICE — the source cell through the ONE price rule (normalizeSourcePrice):
  // below 1000 it is in thousands of UZS and is multiplied by 1000, from 1000
  // up it is UZS as given. No markup, no cost→retail conversion, no rounding.
  // An invalid price rejects the row, so the price already stored for the
  // position is left exactly as it is.
  const sourcePrice = get('price').trim();
  const price = normalizeSourcePrice(sourcePrice, numberFormat);
  if (!price.ok)
    err(
      'invalid_price',
      'price',
      sourcePrice
        ? `price "${sourcePrice}": ${price.reason}`
        : 'price is empty',
    );
  else if (new Prisma.Decimal(price.priceUzs).lt(PRICE_IN_THOUSANDS_BELOW))
    warn(
      'price_below_1000_uzs',
      'price',
      `price "${sourcePrice}" is below 1 even in thousands: imported as ${price.priceUzs} UZS — check the export`,
    );

  const sourceUnit = get('unit').trim();
  const unit = UNIT_CODES[sourceUnit.toLowerCase()];
  if (!unit)
    err(
      'unknown_unit',
      'unit',
      `unit "${sourceUnit}" is not a recognized unit (шт. / штук / л)`,
    );

  // Optional. No `quantity` column or an empty cell means "not given" (null):
  // the write then omits it, so a new stock gets the schema default (1) and an
  // existing stock keeps the count it has. A given value must be a whole
  // number: Stock.quantity is an integer count, so a fraction is rejected,
  // never rounded.
  let quantity: number | null = null;
  if (get('quantity').trim()) {
    const qty = parseDecimal(get('quantity'), 3, numberFormat);
    if (!qty.ok)
      err(
        'invalid_quantity',
        'quantity',
        `quantity "${get('quantity')}": ${qty.reason}`,
      );
    else if (qty.value.lt(0))
      err('invalid_quantity', 'quantity', 'quantity must not be negative');
    else if (qty.value.gt(MAX_QUANTITY))
      err('invalid_quantity', 'quantity', `quantity exceeds ${MAX_QUANTITY}`);
    else if (!qty.value.isInteger())
      err(
        'invalid_quantity',
        'quantity',
        `fractional quantity ${qty.value.toString()} — quantities must be whole numbers`,
      );
    else quantity = qty.value.toNumber();
  }

  const gmNumber = parseGm(get('gmNumber'), err);
  // The manufacturer part number IS code_1c (business rule, 2026-10-18): it is
  // written to products.source_part_number exactly as validated above, and its
  // search form to the oem_numbers index. The export's manufacturer_part_number
  // and oem_numbers cells are never read (NOT_IMPORTED).
  const oemNumbers = codeValid ? indexOem(code1c!, warn) : [];
  const vehicle = parseVehicle(get('vehicleMake'), get('vehicleModel'), err);

  if (!price.ok || issues.some((i) => i.severity === 'error')) {
    return { row: null, code1c, issues };
  }
  return {
    code1c,
    issues,
    row: {
      line,
      code1c: code1c!,
      name,
      priceUzs: price.priceUzs,
      sourcePrice,
      priceScaled: price.scaled,
      quantity,
      unit,
      sourceUnit,
      gmNumber,
      sourcePartNumber: code1c!,
      oemNumbers,
      vehicle: vehicle!.spec,
      vehicleMappings: vehicle!.mappings,
    },
  };
}

export type Report = (
  code: string,
  field: Field | null,
  message: string,
) => void;

/** gm_number: one all-digit number or empty. GM numbers never carry letters. */
function parseGm(raw: string, err: Report): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/\s/.test(value)) {
    err(
      'invalid_gm_number',
      'gmNumber',
      `gm_number "${value}" holds more than one value`,
    );
    return null;
  }
  if (!/^\d+$/.test(value)) {
    err(
      'invalid_gm_number',
      'gmNumber',
      `gm_number "${value}" must contain digits only`,
    );
    return null;
  }
  if (value.length > FIELD_LIMITS.partNumber) {
    err('invalid_gm_number', 'gmNumber', 'gm_number is too long');
    return null;
  }
  return value;
}

/**
 * oem_numbers: the SEARCH INDEX derived from the part number (a validated
 * code_1c — one token, or an 8-digit article and a marker split by single
 * spaces), never the stored value (that is sourcePartNumber, verbatim).
 * normalizeOem uppercases it and drops separators — the space too, as the
 * buyer search does with its query; leading zeros stay. A code that is not a
 * plausible number — anything but Latin letters, digits and . - /, or under 3
 * / over 50 characters once normalized — is left out of the index with a
 * warning: normalizeOem would silently delete e.g. a Cyrillic look-alike letter
 * and index a different number. The 8-digit key itself is added in planning,
 * where the other positions are known. Nothing here rejects the row.
 */
function indexOem(code: string, warn: Report): string[] {
  const normalized = normalizeOem(code);
  if (
    !/^[A-Za-z0-9./-]+(?: [A-Za-z0-9./-]+)*$/.test(code) ||
    normalized.length < 3 ||
    normalized.length > FIELD_LIMITS.partNumber
  ) {
    warn(
      'oem_not_indexed',
      'code1c',
      `"${code}" kept in source_part_number but not added to the OEM search index (only Latin letters, digits, . - / and single spaces, 3–50 characters)`,
    );
    return [];
  }
  if (/^\d{16}$/.test(normalized)) {
    warn(
      'oem_suspect_concatenated',
      'code1c',
      `part number "${code}" looks like two 8-digit numbers without a separator (kept as-is)`,
    );
  }
  return [normalized];
}

/**
 * The vehicle cells of one row, with every model resolved to canonical. Both
 * cells empty → 'none': the row says nothing about fitment (it never makes a
 * part universal). Null when the cells are invalid; `err` names the problem.
 */
export function parseVehicle(
  rawMake: string,
  rawModel: string,
  err: Report,
): { spec: VehicleSpec; mappings: VehicleMapping[] } | null {
  const makeCode = normalizeVehicleCode(rawMake);
  const modelField = rawModel.trim();

  if (!makeCode && !modelField) return { spec: { kind: 'none' }, mappings: [] };
  if (!makeCode) {
    err(
      'invalid_vehicle_combination',
      'vehicleModel',
      `vehicle_model "${modelField}" without a vehicle_make`,
    );
    return null;
  }
  const make = resolveMake(makeCode);
  if (!make) {
    err(
      'unknown_vehicle_make',
      'vehicleMake',
      `vehicle_make "${makeCode}" is not a known make`,
    );
    return null;
  }
  const base = { sourceMake: makeCode, make: make.make };
  if (!modelField) {
    return {
      spec: { kind: 'make', make: make.make },
      mappings: [
        {
          ...base,
          sourceModel: null,
          model: null,
          via: make.via,
          inCanonicalCatalog: make.inCanonicalCatalog,
        },
      ],
    };
  }

  // One cell lists every model the part fits: split on ',' (the export's
  // separator) or ';' (the earlier one), trim, drop blanks, dedupe. Model codes
  // never contain either character. The row stays ONE product; each model
  // becomes its own compatibility link.
  const codes = [
    ...new Set(
      modelField.split(/[,;]/).map(normalizeVehicleCode).filter(Boolean),
    ),
  ];
  const models: string[] = [];
  const mappings: VehicleMapping[] = [];
  let failed = false;
  for (const code of codes) {
    const resolved = resolveModel(make.make, code);
    if (!resolved) {
      failed = true;
      err(
        'unknown_vehicle_model',
        'vehicleModel',
        `vehicle_model "${code}" is not a known ${make.make} model`,
      );
      continue;
    }
    mappings.push({
      ...base,
      sourceModel: code,
      model: resolved.model,
      via: resolved.via,
      inCanonicalCatalog:
        make.inCanonicalCatalog && resolved.inCanonicalCatalog,
    });
    if (!models.includes(resolved.model)) models.push(resolved.model);
  }
  if (failed) return null;
  return { spec: { kind: 'models', make: make.make, models }, mappings };
}
