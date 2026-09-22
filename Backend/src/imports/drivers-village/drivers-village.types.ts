/**
 * Types shared by the Driver's Village 1C importer (reader → parser → planner
 * → store → report). Pure data, no runtime dependencies.
 */
import type { PartMainCategory, PartVehicleCategory } from '@prisma/client';

/** Stock unit codes, the same vocabulary as KindCapabilities.unit. */
export type StockUnit = 'PCS' | 'L';

/**
 * Where an issue comes from — the distinction the dry-run must keep:
 *   • data      — a problem in the source file itself (fix the export);
 *   • reference — the file is fine, but THIS database lacks reference data the
 *                 row needs (e.g. a category id). Typical on a dev/test DB that
 *                 does not mirror production; not a source-data error.
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

/** The three business states of vehicle compatibility. */
export type VehicleSpec =
  | { kind: 'universal' }
  | { kind: 'make'; make: string }
  | { kind: 'models'; make: string; models: string[] };

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
   * The source price, exactly: a canonical decimal string (never a float), at
   * the precision the file supplies. No markup, conversion or rounding.
   */
  priceUzs: string;
  /** Whole number (fractions are rejected by the parser). */
  quantity: number;
  unit: StockUnit;
  sourceUnit: string;
  gmNumber: string | null;
  oemNumbers: string[];
  vehicle: VehicleSpec;
  vehicleMappings: VehicleMapping[];
  categoryId: string;
  subcategoryId: string;
}

/** Category row as the planner needs it. */
export interface CategoryNode {
  id: string;
  parentId: string | null;
  level: number;
  isActive: boolean;
}

/** The import-owned state of a position already in the database. */
export interface ExistingPosition {
  stockId: number;
  productId: number;
  sourceCode: string;
  priceUzs: string;
  quantity: number;
  unit: string | null;
  title: string;
  gmNumbers: string[];
  oemNumbers: string[];
  categoryId: string | null;
  vehicleCategoryId: string | null;
  isUniversal: boolean;
  /** 'Make|Model' pairs from part_models, sorted. */
  models: string[];
  /** Make names from part_makes, sorted. */
  makes: string[];
  imageCount: number;
  hasCatalogPart: boolean;
}

/** Everything the store needs to write one position. */
export interface PositionWrite {
  code1c: string;
  priceUzs: string;
  quantity: number;
  unit: StockUnit;
  product: {
    title: string;
    gmNumbers: string[];
    oemNumbers: string[];
    categoryId: string;
    vehicleCategoryId: string;
    mainCategory: PartMainCategory | null;
    vehicleCategory: PartVehicleCategory | null;
    isUniversal: boolean;
  };
  /** Canonical (make, model) pairs — empty unless vehicle.kind === 'models'. */
  models: { make: string; model: string }[];
  /** Canonical make — set only when vehicle.kind === 'make'. */
  make: string | null;
}

export type PlannedAction = 'create' | 'update' | 'unchanged';

export interface RowPlan {
  row: ParsedRow;
  action: PlannedAction;
  write: PositionWrite;
  /** Import-owned fields that differ from the database (update only). */
  changes: string[];
  existing: ExistingPosition | null;
}
