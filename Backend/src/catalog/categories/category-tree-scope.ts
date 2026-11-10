import { PartMainCategory, PartVehicleCategory, Prisma } from '@prisma/client';
import {
  categoryParentMap,
  mainCategoryForCategory,
  vehicleCategoryForCategory,
} from './category-map';

/**
 * The buyer side's ONE source of a part's home-grid bucket and vehicle system:
 * the part's `category_id` and the LIVE category tree.
 *
 * `catalog_parts.main_category` / `vehicle_category` are stored copies, written
 * when a part is projected, classified or moved. A copy stops agreeing with the
 * tree whenever the tree changes after the write (an admin moves a node), when
 * a writer predates the tree rule (bulk-move before 2026-10-20), or when an
 * imported position keeps its creation-time value. Buyer reads therefore never
 * filter or count by those columns; they derive both from `category_id` here,
 * through the same rules the projection and the backfill use
 * (mainCategoryForCategory / vehicleCategoryForCategory), so the grid, the
 * listing and the payload cannot disagree with the tree or with each other.
 *
 * The columns stay: the seller bot, the projection, the admin console and the
 * fiscal path still read and write them.
 */

/** One edge of the category tree — all a derivation needs. */
export interface CategoryEdge {
  id: string;
  parentId: string | null;
  /** Absent means active. */
  isActive?: boolean;
}

export const CATEGORY_EDGE_SELECT = {
  id: true,
  parentId: true,
  isActive: true,
} satisfies Prisma.PartCategorySelect;

/** The Prisma surface the loader reads: the client or a test double. */
export interface CategoryEdgeReader {
  partCategory: {
    findMany(args: {
      select: typeof CATEGORY_EDGE_SELECT;
    }): Promise<CategoryEdge[]>;
  };
}

/** A part's classification as the tree states it. */
export interface TreeClassification {
  mainCategory: PartMainCategory | null;
  vehicleCategory: PartVehicleCategory | null;
}

export interface CategoryTreeScope {
  /** The home-grid bucket a part filed on `categoryId` belongs to, or null. */
  mainCategoryOf(categoryId: string): PartMainCategory | null;
  /** The vehicle system (its root's enum) of `categoryId`, or null. */
  vehicleCategoryOf(categoryId: string): PartVehicleCategory | null;
  /** Both of the above. */
  classify(categoryId: string): TreeClassification;
  /** Every category id whose parts belong to `bucket`. */
  idsInMainCategory(bucket: PartMainCategory): string[];
  /** Every category id whose parts belong to `system`. */
  idsInVehicleCategory(system: PartVehicleCategory): string[];
  /** Is this node, or any node above it, deactivated? */
  isHidden(categoryId: string): boolean;
  /** Every category id that is hidden, for filtering a query. */
  hiddenIds(): string[];
}

/**
 * THE rule for what a deactivated category does to buyers: its parts, and those of
 * every node beneath it, are not listed, counted, searched or sold. The rows stay, and
 * reactivating brings them back. Null when nothing is hidden, which is the usual case.
 */
export function visibleCategoryWhere(
  tree: Pick<CategoryTreeScope, 'hiddenIds'>,
): Prisma.CatalogPartWhereInput | null {
  const hidden = tree.hiddenIds();
  return hidden.length > 0 ? { categoryId: { notIn: hidden } } : null;
}

/**
 * Build the scope over a tree snapshot. Every node is classified once, up
 * front: the tree is under a hundred rows, and both directions (id → bucket,
 * bucket → ids) are then plain lookups.
 *
 * A category the snapshot does not hold (a part filed on a node created after
 * the read) still gets its own rule — mainCategoryForCategory decides a
 * bucket row or a listed node by id — and no vehicle system.
 */
export function categoryTreeScope(
  edges: readonly CategoryEdge[],
): CategoryTreeScope {
  const parentOf = categoryParentMap(edges);
  const known = new Map<string, TreeClassification>();
  const byMain = new Map<PartMainCategory, string[]>();
  const byVehicle = new Map<PartVehicleCategory, string[]>();

  const derive = (categoryId: string): TreeClassification => ({
    mainCategory: mainCategoryForCategory(categoryId, parentOf),
    vehicleCategory: vehicleCategoryForCategory(categoryId, parentOf),
  });

  for (const { id } of edges) {
    const c = derive(id);
    known.set(id, c);
    if (c.mainCategory) {
      byMain.set(c.mainCategory, [...(byMain.get(c.mainCategory) ?? []), id]);
    }
    if (c.vehicleCategory) {
      byVehicle.set(c.vehicleCategory, [
        ...(byVehicle.get(c.vehicleCategory) ?? []),
        id,
      ]);
    }
  }

  const classify = (categoryId: string) =>
    known.get(categoryId) ?? derive(categoryId);

  const inactive = new Set(
    edges.filter((e) => e.isActive === false).map((e) => e.id),
  );
  const hidden = new Set<string>();
  if (inactive.size > 0) {
    for (const { id } of edges) {
      // Bounded by a seen-set, so a malformed cycle ends.
      const seen = new Set<string>();
      let node: string | null | undefined = id;
      while (node && !seen.has(node)) {
        if (inactive.has(node)) {
          hidden.add(id);
          break;
        }
        seen.add(node);
        node = parentOf.get(node);
      }
    }
  }

  return {
    classify,
    mainCategoryOf: (categoryId) => classify(categoryId).mainCategory,
    vehicleCategoryOf: (categoryId) => classify(categoryId).vehicleCategory,
    idsInMainCategory: (bucket) => [...(byMain.get(bucket) ?? [])],
    idsInVehicleCategory: (system) => [...(byVehicle.get(system) ?? [])],
    isHidden: (categoryId) => hidden.has(categoryId),
    hiddenIds: () => [...hidden],
  };
}

/**
 * Read the live tree and build its scope. One small query (id + parent of
 * every category), deliberately not cached: an admin's move must show on the
 * very next request, and the read costs less than any of the queries it sits
 * beside.
 */
export async function loadCategoryTreeScope(
  db: CategoryEdgeReader,
): Promise<CategoryTreeScope> {
  const edges = await db.partCategory.findMany({
    select: CATEGORY_EDGE_SELECT,
  });
  return categoryTreeScope(edges);
}
