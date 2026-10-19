/**
 * The Driver's Village CLASSIFICATION import — its rules: resolve a file's
 * category against the live category tree and decide, per stored position,
 * what may be applied. Pure: no I/O. Reading the file:
 * drivers-village-classification.ts.
 *
 * ── Who owns a category ──
 * An operator classifies a position in the admin console, which writes
 * catalog_parts.category_id only (bulk-move, or a category delete with
 * reassignment). No column or audit row records who set a category, and
 * maintenance scripts write the same column, so a manual classification cannot
 * be told from another one. The rule therefore never tries: EVERY category
 * already on a catalog part is kept as if an operator set it
 * (`manual_category_preserved`); only a position that is not classified —
 * its part sits in the fallback bucket (cat_uncategorized) or does not exist
 * yet — receives the file's category. (products.category_id of a Driver's
 * Village product is no manual channel: no admin path writes it, and a
 * Telegram listing can never reach such a product.) One refinement is allowed:
 * a stored category is kept and the file's category BELOW it is filled in —
 * the stored level stays, the next level follows the hierarchy.
 *
 * ── Vehicles ──
 * Links are only ADDED (part_models / part_makes); none is ever removed, so
 * empty cells change nothing. Manual fitment lives in fitment_bindings (the
 * Fitment Studio), which this import never writes. The universal flag of a
 * Driver's Village product was only ever set by the 1C import from empty
 * vehicle cells (no admin path sets it), so a product marked universal that
 * way becomes specific when the file names its vehicles.
 */
import type { PartMainCategory, PartVehicleCategory } from '@prisma/client';
import { CatalogProjectionService } from '../../catalog/projection/catalog-projection.service';
import {
  MAIN_CATEGORY_BY_SLUG,
  VEHICLE_CATEGORY_BY_SLUG,
} from '../../catalog/categories/category-map';
import {
  describeCells,
  type CategoryCells,
  type ClassificationSource,
} from './drivers-village-classification';
import type { ImportIssue, VehicleLinks } from './drivers-village.types';

const UNCATEGORIZED = CatalogProjectionService.UNCATEGORIZED_ID;

// ── Category tree ───────────────────────────────────────────────────────────

export interface CategoryNode {
  id: string;
  parentId: string | null;
  isActive: boolean;
}

export type CategoryTree = ReadonlyMap<string, CategoryNode>;

/** A node and its ancestors, node first, root last; null on a broken chain. */
export function ancestry(tree: CategoryTree, id: string): string[] | null {
  const path: string[] = [];
  let cursor: CategoryNode | undefined = tree.get(id);
  while (cursor) {
    if (path.includes(cursor.id)) return null; // a cycle
    path.push(cursor.id);
    if (!cursor.parentId) return path;
    cursor = tree.get(cursor.parentId);
  }
  return null; // a missing node or parent
}

export type CategoryResolution =
  | { kind: 'ok'; nodeId: string; rootId: string; path: string[] }
  | {
      kind: 'invalid';
      code:
        | 'category_unknown'
        | 'category_inactive'
        | 'category_mismatch'
        | 'category_fallback';
      message: string;
    };

/**
 * The node a file's category cells name, checked against the live tree: it
 * exists, it and every ancestor are active, it is no fallback bucket, and a
 * given category_id is the subcategory's ancestor. Never created, never
 * guessed — a category_id that is not the subcategory's real parent is a
 * contradiction, even when the subcategory alone would resolve.
 */
export function resolveCategory(
  cells: CategoryCells,
  tree: CategoryTree,
): CategoryResolution {
  const invalid = (
    code: Extract<CategoryResolution, { kind: 'invalid' }>['code'],
    message: string,
  ): CategoryResolution => ({ kind: 'invalid', code, message });
  const nodeId = (cells.subcategoryId ?? cells.categoryId)!;
  if (!tree.has(nodeId))
    return invalid(
      'category_unknown',
      `"${nodeId}" is no category in Mator (part_categories) — an import never creates one`,
    );
  const path = ancestry(tree, nodeId);
  if (!path)
    return invalid(
      'category_unknown',
      `the parents of "${nodeId}" are broken in part_categories`,
    );
  const inactive = path.find((id) => !tree.get(id)!.isActive);
  if (inactive)
    return invalid(
      'category_inactive',
      inactive === nodeId
        ? `"${nodeId}" is not an active category in Mator`
        : `"${nodeId}" sits under the inactive category "${inactive}"`,
    );
  if (nodeId === UNCATEGORIZED)
    return invalid(
      'category_fallback',
      `"${UNCATEGORIZED}" is the fallback bucket, not a classification`,
    );
  if (
    cells.categoryId &&
    cells.subcategoryId &&
    cells.categoryId !== cells.subcategoryId &&
    !path.includes(cells.categoryId)
  )
    return invalid(
      'category_mismatch',
      `subcategory "${nodeId}" belongs to ${
        path.length > 1
          ? path
              .slice(1)
              .map((id) => `"${id}"`)
              .join(' → ')
          : 'no parent'
      } in Mator, not to "${cells.categoryId}" — fix category_id in the file`,
    );
  return { kind: 'ok', nodeId, rootId: path[path.length - 1], path };
}

// ── Decisions ───────────────────────────────────────────────────────────────

/** A stored position, as the classification import reads it. */
export interface ClassificationTarget {
  stockId: number;
  productId: number;
  code1c: string;
  isUniversal: boolean;
  /** The catalog part's category; null when the stock has no part yet. */
  partCategoryId: string | null;
  /** 'Make|Model' pairs from part_models. */
  models: string[];
  /** Make names from part_makes. */
  makes: string[];
  /** Fitment Studio bindings of the catalog part (fitment_bindings). */
  curatedBindings: number;
}

/** The product's classification columns, written as one unit. */
export interface ProductClassification {
  categoryId: string;
  vehicleCategoryId: string;
  mainCategory: PartMainCategory | null;
  vehicleCategory: PartVehicleCategory | null;
}

export type CategoryAction =
  | 'assign'
  | 'refine'
  | 'unchanged'
  | 'preserved'
  | 'invalid'
  | 'conflict'
  | 'none';

export interface CategoryDecision {
  action: CategoryAction;
  /** The category the position has now; null = not classified. */
  existing: string | null;
  /** What is written ('assign' / 'refine'); null otherwise. */
  set: ProductClassification | null;
  issue: ImportIssue | null;
}

/**
 * What the file may do to a position's category (see the file header):
 *   none      — the file gives no category;
 *   conflict  — its rows give different ones;
 *   invalid   — the category is unknown, inactive or contradictory;
 *   assign    — the position is not classified: the file's category;
 *   unchanged — it already has exactly that category;
 *   refine    — the file's category lies BELOW the stored one: filled in;
 *   preserved — anything else: the stored category stays, the file's value
 *               is ignored and reported (manual_category_preserved).
 */
export function decideCategory(
  source: ClassificationSource,
  target: ClassificationTarget,
  tree: CategoryTree,
): CategoryDecision {
  const existing =
    target.partCategoryId && target.partCategoryId !== UNCATEGORIZED
      ? target.partCategoryId
      : null;
  const warn = (code: string, message: string): ImportIssue => ({
    line: source.lines[0],
    code1c: source.code1c,
    kind: 'data',
    severity: 'warning',
    code,
    field: 'category',
    message,
  });
  const keep = (action: CategoryAction, issue: ImportIssue | null) => ({
    action,
    existing,
    set: null,
    issue,
  });

  if (source.category === null) return keep('none', null);
  if (source.category === 'conflict')
    return keep(
      'conflict',
      warn(
        'category_conflict',
        `the rows of code_1c "${source.code1c}" give different categories (${source.pairs.map(describeCells).join('; ')}) — none is applied`,
      ),
    );
  const resolved = resolveCategory(source.category, tree);
  if (resolved.kind === 'invalid')
    return keep(
      'invalid',
      warn(
        resolved.code,
        `${describeCells(source.category)}: ${resolved.message}; the category is not changed`,
      ),
    );
  const set: ProductClassification = {
    categoryId: resolved.nodeId,
    vehicleCategoryId: resolved.rootId,
    mainCategory: MAIN_CATEGORY_BY_SLUG.get(resolved.nodeId) ?? null,
    vehicleCategory: VEHICLE_CATEGORY_BY_SLUG.get(resolved.rootId) ?? null,
  };
  if (existing === null)
    return { action: 'assign', existing, set, issue: null };
  if (existing === resolved.nodeId) return keep('unchanged', null);
  if (resolved.path.slice(1).includes(existing))
    return {
      action: 'refine',
      existing,
      set,
      issue: warn(
        'category_refined',
        `the category set in Mator, "${existing}", is kept and made more precise: "${resolved.nodeId}" lies below it`,
      ),
    };
  return keep(
    'preserved',
    warn(
      'manual_category_preserved',
      `the category set in Mator, "${existing}", is kept; the file's ${describeCells(source.category)} ("${resolved.nodeId}") is ignored — an import never replaces a category set in Mator`,
    ),
  );
}

export interface VehicleDecision {
  /** (make, model) pairs the position does not have yet. */
  addModels: { make: string; model: string }[];
  /** Make-wide makes the position does not have yet. */
  addMakes: string[];
  /** The import-set universal flag gives way to the vehicles the file names. */
  clearUniversal: boolean;
}

/** The vehicles to ADD to a position — never one to remove (file header). */
export function decideVehicles(
  links: VehicleLinks,
  target: ClassificationTarget,
): VehicleDecision {
  const models = new Set(target.models);
  const makes = new Set(target.makes);
  return {
    addModels: links.models.filter((m) => !models.has(`${m.make}|${m.model}`)),
    addMakes: links.makes.filter((m) => !makes.has(m)),
    clearUniversal:
      target.isUniversal && links.models.length + links.makes.length > 0,
  };
}

/** Everything the classification store writes for one position. */
export interface ClassificationWrite {
  code1c: string;
  stockId: number;
  productId: number;
  /**
   * The product classification to write, only while the catalog part still
   * has `expectedPartCategory` (null = no part) — a compare-and-set, so a
   * category an operator sets meanwhile always wins.
   */
  category: {
    expectedPartCategory: string | null;
    set: ProductClassification;
  } | null;
  clearUniversal: boolean;
  addModels: { make: string; model: string }[];
  addMakes: string[];
}
