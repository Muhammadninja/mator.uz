/**
 * Pure planning steps of the Driver's Village import: resolve a row's
 * categories against the database tree, build the write, and diff it against
 * what is already stored. No I/O.
 */
import { Prisma } from '@prisma/client';
import {
  MAIN_CATEGORY_BY_SLUG,
  VEHICLE_CATEGORY_BY_SLUG,
} from '../../catalog/categories/category-map';
import type {
  CategoryNode,
  ExistingPosition,
  ImportIssue,
  ParsedRow,
  PositionWrite,
} from './drivers-village.types';

export interface CategoryResolution {
  /** Null when the row cannot be written in this database. */
  write: Pick<
    PositionWrite['product'],
    'categoryId' | 'vehicleCategoryId' | 'mainCategory' | 'vehicleCategory'
  > | null;
  issues: ImportIssue[];
}

/**
 * Carry the approved ids through, per the existing Product contract:
 *   categoryId        = subcategory_id (the precise node)
 *   vehicleCategoryId = the ROOT (level 0) of category_id, read from the tree
 *   mainCategory      = the legacy enum mirrored by subcategory_id, else by
 *                       category_id (MAIN_CATEGORY_BY_SLUG) — else null
 *   vehicleCategory   = the legacy enum mirrored by the root — else null
 *
 * Nothing is guessed, created or matched fuzzily. An id missing from THIS
 * database is a 'reference' issue (environment), not a source-data error, and
 * blocks only the write. A pair whose subcategory is not under the category's
 * root is imported as given, with a warning.
 */
export function resolveCategories(
  row: ParsedRow,
  tree: Map<string, CategoryNode>,
): CategoryResolution {
  const issues: ImportIssue[] = [];
  const ref = (
    code: string,
    field: string,
    message: string,
    severity: 'error' | 'warning' = 'error',
  ) =>
    issues.push({
      line: row.line,
      code1c: row.code1c,
      kind: 'reference',
      severity,
      code,
      field,
      message,
    });

  const category = tree.get(row.categoryId);
  const sub = tree.get(row.subcategoryId);
  if (!category)
    ref(
      'category_not_in_database',
      'categoryId',
      `category_id "${row.categoryId}" does not exist in this database (required reference data)`,
    );
  if (!sub)
    ref(
      'subcategory_not_in_database',
      'subcategoryId',
      `subcategory_id "${row.subcategoryId}" does not exist in this database (required reference data)`,
    );
  if (!category || !sub) return { write: null, issues };

  const root = rootOf(category, tree);
  if (!root) {
    ref(
      'category_tree_broken',
      'categoryId',
      `category_id "${row.categoryId}" has no reachable root in this database`,
    );
    return { write: null, issues };
  }
  if (rootOf(sub, tree)?.id !== root.id) {
    ref(
      'category_lineage_mismatch',
      'subcategoryId',
      `subcategory_id "${row.subcategoryId}" is not under the root "${root.id}" of category_id "${row.categoryId}" in this database (imported as given)`,
      'warning',
    );
  }
  for (const node of [category, sub]) {
    if (!node.isActive)
      ref(
        'category_inactive',
        'categoryId',
        `category "${node.id}" is inactive in this database (imported as given)`,
        'warning',
      );
  }

  return {
    issues,
    write: {
      categoryId: sub.id,
      vehicleCategoryId: root.id,
      mainCategory:
        MAIN_CATEGORY_BY_SLUG.get(sub.id) ??
        MAIN_CATEGORY_BY_SLUG.get(category.id) ??
        null,
      vehicleCategory: VEHICLE_CATEGORY_BY_SLUG.get(root.id) ?? null,
    },
  };
}

/** Walk parents to the level-0 node (bounded; a cycle yields null). */
function rootOf(
  node: CategoryNode,
  tree: Map<string, CategoryNode>,
): CategoryNode | null {
  let current: CategoryNode | undefined = node;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (current.parentId === null) return current.level === 0 ? current : null;
    current = tree.get(current.parentId);
  }
  return null;
}

export function buildWrite(
  row: ParsedRow,
  categories: NonNullable<CategoryResolution['write']>,
): PositionWrite {
  return {
    code1c: row.code1c,
    priceUzs: row.priceUzs,
    quantity: row.quantity,
    unit: row.unit,
    product: {
      title: row.name,
      gmNumbers: row.gmNumber ? [row.gmNumber] : [],
      oemNumbers: row.oemNumbers,
      ...categories,
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
  if (w.quantity !== e.quantity) changes.push('quantity');
  if (w.unit !== e.unit) changes.push('unit');
  if (w.product.title !== e.title) changes.push('name');
  if (listDiffers(w.product.gmNumbers, e.gmNumbers)) changes.push('gm_number');
  if (listDiffers(w.product.oemNumbers, e.oemNumbers))
    changes.push('oem_numbers');
  if (
    w.product.categoryId !== e.categoryId ||
    w.product.vehicleCategoryId !== e.vehicleCategoryId
  )
    changes.push('category');
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
    const vehicle =
      r.vehicle.kind === 'universal'
        ? '*'
        : r.vehicle.kind === 'make'
          ? `${r.vehicle.make}|*`
          : `${r.vehicle.make}|${[...r.vehicle.models].sort().join(',')}`;
    const key = `${r.name.toLowerCase()} :: ${vehicle} :: ${[...r.oemNumbers].sort().join(' ')}`;
    groups.set(key, [...(groups.get(key) ?? []), r.code1c]);
  }
  return [...groups]
    .filter(([, codes]) => codes.length > 1)
    .map(([key, codes]) => ({ key, codes }));
}
