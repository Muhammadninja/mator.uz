/**
 * Turns the cells of one Driver's Village 1C row into a validated ParsedRow, or
 * reports why it cannot be imported. Pure: no I/O, no database.
 *
 * Every check here is about the SOURCE DATA. Whether the referenced categories
 * exist in a given database is a separate, environment-level question answered
 * by the planner (reported with kind 'reference').
 */
import { Prisma } from '@prisma/client';
import { normalizeOem } from '../../common/normalize-oem.util';
import {
  FIELD_LIMITS,
  MAX_PRICE_UZS,
  MAX_QUANTITY,
} from './drivers-village.constants';
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
  categoryId: ['category_id'],
  subcategoryId: ['subcategory_id'],
  gmNumber: ['gm_number'],
  // `manufacturer_part_number` is the column the CURRENT export carries. It
  // holds the vehicle manufacturer's part numbers — i.e. OEM numbers, space
  // separated, possibly with letters — so it feeds oem_numbers. It is never
  // stored under its own name, and never read as a GM number.
  oemNumbers: ['oem_numbers', 'manufacturer_part_number'],
} as const;

export type Field = keyof typeof HEADER_ALIASES;

const REQUIRED: Field[] = [
  'code1c',
  'name',
  'quantity',
  'unit',
  'price',
  'vehicleMake',
  'vehicleModel',
  'categoryId',
  'subcategoryId',
];

export interface HeaderMap {
  index: Partial<Record<Field, number>>;
  /** Header text actually used for each field. */
  source: Partial<Record<Field, string>>;
  ignored: string[];
  errors: string[];
}

export function mapHeaders(cells: string[]): HeaderMap {
  const map: HeaderMap = { index: {}, source: {}, ignored: [], errors: [] };
  const normalized = cells.map((c) => c.trim().toLowerCase());

  normalized.forEach((header, i) => {
    const field = (Object.keys(HEADER_ALIASES) as Field[]).find((f) =>
      (HEADER_ALIASES[f] as readonly string[]).includes(header),
    );
    if (!field) {
      if (header) map.ignored.push(cells[i].trim());
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
  'л.': 'L',
  л: 'L',
  литр: 'L',
};

/** Spaces 1C/Excel use as thousands separators (regular, NBSP, thin, narrow). */
const GROUP_SEPARATORS = /[ \u00a0\u2009\u202f]/g;

export function parseRow(
  cells: string[],
  line: number,
  headers: HeaderMap,
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

  // code_1c — the position's identity in 1C, stored verbatim (trimmed).
  if (!code1c) err('empty_code_1c', 'code1c', 'code_1c is empty');
  else if (code1c.length > FIELD_LIMITS.code1c)
    err(
      'invalid_code_1c',
      'code1c',
      `code_1c longer than ${FIELD_LIMITS.code1c} characters`,
    );
  else if (!/^[\p{L}\p{N}._/-]+$/u.test(code1c))
    err(
      'invalid_code_1c',
      'code1c',
      `code_1c "${code1c}" contains whitespace or unsupported characters`,
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

  // PRICE — the source value, exactly. Driver's Village's price per unit in
  // UZS is written as given: no markup, no retail multiplier, no cost→retail
  // conversion, no reinterpretation. It is parsed as a decimal string (never a
  // float) and must have at most 2 decimal places (tiyin, the precision of
  // Stock.priceUzs); more precision is REJECTED rather than rounded, so the
  // stored value always equals the file's value.
  const price = parseDecimal(get('price'), 2);
  if (!price.ok)
    err('invalid_price', 'price', `price "${get('price')}": ${price.reason}`);
  else if (!price.value.gt(0))
    err('invalid_price', 'price', 'price must be greater than 0');
  else if (price.value.gt(MAX_PRICE_UZS))
    err('invalid_price', 'price', 'price exceeds 999 999 999 999.99');

  const sourceUnit = get('unit').trim();
  const unit = UNIT_CODES[sourceUnit.toLowerCase()];
  if (!unit)
    err(
      'unknown_unit',
      'unit',
      `unit "${sourceUnit}" is not a recognized unit (шт. / л)`,
    );

  // Whole numbers only: Stock.quantity is an integer count and the source
  // carries no fractions. A fractional value is rejected, never rounded.
  const qty = parseDecimal(get('quantity'), 3);
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

  const gmNumber = parseGm(get('gmNumber'), err);
  const oemNumbers = parseOem(get('oemNumbers'), err, warn);
  const vehicle = parseVehicle(get('vehicleMake'), get('vehicleModel'), err);
  const categoryId = parseCategoryId(get('categoryId'), 'categoryId', err);
  const subcategoryId = parseCategoryId(
    get('subcategoryId'),
    'subcategoryId',
    err,
  );

  if (issues.some((i) => i.severity === 'error')) {
    return { row: null, code1c, issues };
  }
  return {
    code1c,
    issues,
    row: {
      line,
      code1c: code1c!,
      name,
      priceUzs: price.ok ? price.value.toFixed(2) : '',
      quantity: qty.ok ? qty.value.toNumber() : 0,
      unit,
      sourceUnit,
      gmNumber,
      oemNumbers,
      vehicle: vehicle!.spec,
      vehicleMappings: vehicle!.mappings,
      categoryId: categoryId as string,
      subcategoryId: subcategoryId as string,
    },
  };
}

type DecimalResult =
  { ok: true; value: Prisma.Decimal } | { ok: false; reason: string };

/**
 * Parse a 1C/Excel number ("195 642,86", "1 060 387,74", "8") exactly — never
 * through a float. Group separators are spaces; the decimal separator is a
 * comma (a dot is accepted too). Anything else is rejected, not guessed.
 */
export function parseDecimal(raw: string, maxFraction: number): DecimalResult {
  const compact = raw.trim().replace(GROUP_SEPARATORS, '');
  if (!compact) return { ok: false, reason: 'empty' };
  if ((compact.match(/[,.]/g) ?? []).length > 1)
    return { ok: false, reason: 'more than one decimal separator' };
  const normalized = compact.replace(',', '.');
  const m = /^(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!m) return { ok: false, reason: 'not a plain non-negative number' };
  if ((m[2]?.length ?? 0) > maxFraction)
    return { ok: false, reason: `more than ${maxFraction} decimal places` };
  return { ok: true, value: new Prisma.Decimal(normalized) };
}

type Report = (code: string, field: Field | null, message: string) => void;

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
 * oem_numbers: space-separated values → normalized (normalizeOem: uppercase,
 * separators removed), deduplicated, source order kept. A value with anything
 * but Latin letters, digits and . - / is malformed — normalizeOem would
 * silently delete e.g. a Cyrillic look-alike letter, so it is rejected instead.
 */
function parseOem(raw: string, err: Report, warn: Report): string[] {
  const value = raw.trim();
  if (!value) return [];
  if (value.includes(',') || value.includes(';')) {
    warn(
      'oem_nonstandard_separator',
      'oemNumbers',
      `oem values "${value}" use ',' or ';' — treated as a separator like a space`,
    );
  }
  const out: string[] = [];
  for (const token of value.split(/[\s,;]+/).filter(Boolean)) {
    if (!/^[A-Za-z0-9./-]+$/.test(token)) {
      err(
        'malformed_oem',
        'oemNumbers',
        `oem value "${token}" contains unsupported characters`,
      );
      continue;
    }
    const normalized = normalizeOem(token);
    if (normalized.length < 3 || normalized.length > FIELD_LIMITS.partNumber) {
      err(
        'malformed_oem',
        'oemNumbers',
        `oem value "${token}" has an implausible length`,
      );
      continue;
    }
    if (/^\d{16}$/.test(normalized)) {
      warn(
        'oem_suspect_concatenated',
        'oemNumbers',
        `oem value "${token}" looks like two 8-digit numbers without a separator (kept as-is)`,
      );
    }
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

/** The three valid vehicle states, with every model resolved to canonical. */
function parseVehicle(
  rawMake: string,
  rawModel: string,
  err: Report,
): { spec: VehicleSpec; mappings: VehicleMapping[] } | null {
  const makeCode = normalizeVehicleCode(rawMake);
  const modelField = rawModel.trim();

  if (!makeCode && !modelField)
    return { spec: { kind: 'universal' }, mappings: [] };
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

  // Split on ';', trim, drop blanks, dedupe. ',' is NOT a separator: it occurs
  // inside real codes (MALIBU-1,5-TURBO); a ", " list is reported instead.
  const codes = [
    ...new Set(modelField.split(';').map(normalizeVehicleCode).filter(Boolean)),
  ];
  const models: string[] = [];
  const mappings: VehicleMapping[] = [];
  let failed = false;
  for (const code of codes) {
    const resolved = resolveModel(make.make, code);
    if (!resolved) {
      failed = true;
      err(
        code.includes(', ')
          ? 'vehicle_model_comma_list'
          : 'unknown_vehicle_model',
        'vehicleModel',
        code.includes(', ')
          ? `vehicle_model "${code}" looks like a ','-separated list — separate models with ';'`
          : `vehicle_model "${code}" is not a known ${make.make} model`,
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

function parseCategoryId(
  raw: string,
  field: Field,
  err: Report,
): string | null {
  const value = raw.trim();
  const column = field === 'categoryId' ? 'category_id' : 'subcategory_id';
  if (!value) {
    err('empty_category', field, `${column} is empty`);
    return null;
  }
  if (
    value.length > FIELD_LIMITS.categoryId ||
    !/^[a-z0-9][a-z0-9_-]*$/.test(value)
  ) {
    err(
      'invalid_category_id',
      field,
      `${column} "${value}" is not a category id`,
    );
    return null;
  }
  return value;
}
