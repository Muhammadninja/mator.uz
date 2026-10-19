/**
 * Types shared by the Driver's Village 1C importer (reader → parser → planner
 * → store → report). Pure data, no runtime dependencies.
 */

/** Stock unit codes, the same vocabulary as KindCapabilities.unit. */
export type StockUnit = 'PCS' | 'L';

/**
 * Where an issue comes from — the distinction the dry-run must keep:
 *   • data      — a problem in the source file itself (fix the export);
 *   • reference — the file is fine, but THIS database lacks reference data the
 *                 row refers to (e.g. a vehicle name, or the linked seller).
 *                 Typical on a dev/test DB that does not mirror production;
 *                 not a source-data error.
 */
export type IssueKind = 'data' | 'reference';

export type IssueSeverity = 'error' | 'warning';

/** One problem attached to a row (or to the file, when line is null). */
export interface ImportIssue {
  line: number | null;
  code1c: string | null;
  kind: IssueKind;
  severity: IssueSeverity;
  /** Stable machine-readable code, e.g. 'invalid_price'. */
  code: string;
  field: string | null;
  message: string;
}

/**
 * What one row says about vehicle compatibility. Empty make and model cells
 * say nothing ('none') — they never mean "fits every vehicle": the export has
 * no way to state that, and a universal flag is never derived from a blank.
 */
export type VehicleSpec =
  | { kind: 'none' }
  | { kind: 'make'; make: string }
  | { kind: 'models'; make: string; models: string[] };

/**
 * The fitment links of one position, merged over every row of its code_1c
 * (rows of one code may list different models; none of them is dropped).
 */
export interface VehicleLinks {
  /** Canonical (make, model) pairs — part_models. */
  models: { make: string; model: string }[];
  /** Canonical makes fitted make-wide — part_makes. */
  makes: string[];
}

/** How one source (make, model) code resolved to a canonical vehicle. */
export interface VehicleMapping {
  sourceMake: string;
  sourceModel: string | null;
  make: string;
  model: string | null;
  /** 'alias' = exact alias in VEHICLE_CATALOG; 'table' = explicit 1C code table. */
  via: 'alias' | 'table';
  /** False when the canonical name is outside the canonical vehicle catalog. */
  inCanonicalCatalog: boolean;
}

/** A source row that passed every data check. */
export interface ParsedRow {
  /** 1-based physical record number in the file (header = 1). */
  line: number;
  code1c: string;
  name: string;
  /**
   * The Mator price in UZS: the source cell through normalizeSourcePrice
   * (below 1000 → ×1000), as a canonical 2-decimal string — never a float,
   * never rounded. Derived from the file alone, never from a stored price.
   */
  priceUzs: string;
  /** The price cell as the file holds it (trimmed), for the report. */
  sourcePrice: string;
  /** True when the source price was in thousands and was multiplied by 1000. */
  priceScaled: boolean;
  /**
   * Whole number (fractions are rejected by the parser), or null when the file
   * gives none — no `quantity` column, or an empty cell. Null is never written:
   * a new stock gets the schema default (1), an existing one keeps its count.
   */
  quantity: number | null;
  unit: StockUnit;
  sourceUnit: string;
  gmNumber: string | null;
  /**
   * The manufacturer part number: code_1c itself (business rule, 2026-10-18),
   * exactly as validated — trimmed only; case, leading zeros and every
   * character kept. The export's manufacturer_part_number / oem_numbers cells
   * are never read.
   */
  sourcePartNumber: string;
  /** Search index derived from the part number (normalized, plausible only). */
  oemNumbers: string[];
  vehicle: VehicleSpec;
  vehicleMappings: VehicleMapping[];
}

/** A code_1c on more than one row of the file — written as ONE position. */
export interface DuplicateCode {
  code1c: string;
  /** How many rows carry the code. */
  rows: number;
  /** Their lines, in file order. */
  lines: number[];
  /** The row whose price is the highest valid one; null when none qualifies. */
  chosenLine: number | null;
  /** That row's normalized price (UZS) — the price written; null with it. */
  priceUzs: string | null;
  /** Import-owned fields other than the price in which the valid rows differ. */
  differs: string[];
}

/**
 * A new code_1c that shares its 8-digit key with other codes. It is created
 * as a position of its own; nothing is merged and no stored position changes.
 */
export interface CodeKeyShared {
  key: string;
  line: number;
  code1c: string;
  /** Other codes of the file with the key. */
  fileCodes: string[];
  /** Positions stored with the key; none of them changes. */
  storedCodes: string[];
  /** Stored codes this one may be a 1C rename of — for an operator to check. */
  possibleRenameOf: string[];
}

/**
 * The buyer vehicle reference by NAME (vehicle_makes / vehicle_models) — the
 * names the garage filter compares catalog_part_fits rows with.
 */
export interface VehicleReference {
  makes: string[];
  /** 'Make|Model' pairs. */
  models: string[];
}

/** The state of a position already in the database, as the sync reads it. */
export interface ExistingPosition {
  stockId: number;
  productId: number;
  sourceCode: string;
  priceUzs: string;
  quantity: number;
  unit: string | null;
  title: string;
  gmNumbers: string[];
  sourcePartNumber: string | null;
  oemNumbers: string[];
  /**
   * The category the position is filed under — the catalog part's (where an
   * operator classifies it) once projected, else the product's. Read for the
   * report only: the sync never writes a category.
   */
  categoryId: string | null;
  isUniversal: boolean;
  /** 'Make|Model' pairs from part_models, sorted. */
  models: string[];
  /** Make names from part_makes, sorted. */
  makes: string[];
  imageCount: number;
  hasCatalogPart: boolean;
}

/**
 * Initial creation of a position the database does not have yet: everything
 * the store writes for it. There is deliberately no category here:
 * classification is Mator's (or the separate classification import's).
 */
export interface PositionWrite {
  kind: 'create';
  code1c: string;
  priceUzs: string;
  /** Null = not in the file: omitted from the write (see ParsedRow.quantity). */
  quantity: number | null;
  unit: StockUnit;
  product: {
    title: string;
    gmNumbers: string[];
    sourcePartNumber: string | null;
    oemNumbers: string[];
  };
  /** Canonical (make, model) pairs, merged over the code's rows. */
  models: { make: string; model: string }[];
  /** Canonical makes fitted make-wide, merged over the code's rows. */
  makes: string[];
}

/**
 * The synchronization of a position that exists: its stock price and, only
 * when the file states it, its quantity. Nothing else of the position is
 * written. A null field is left exactly as stored.
 */
export interface StockSync {
  kind: 'sync';
  code1c: string;
  /** The stock found by (seller, DRIVERS_VILLAGE_1C, code1c) when planning. */
  stockId: number;
  /** The new price; null = unchanged, not written. */
  priceUzs: string | null;
  /** The new quantity; null = unchanged or not stated, not written. */
  quantity: number | null;
}

export type BatchWrite = PositionWrite | StockSync;

export type PlannedAction = 'create' | 'update' | 'unchanged';

export interface RowPlan {
  row: ParsedRow;
  action: PlannedAction;
  /** Null for 'unchanged'. */
  write: BatchWrite | null;
  /** What the sync writes: 'price' / 'quantity' (update only). */
  changes: string[];
  existing: ExistingPosition | null;
}
