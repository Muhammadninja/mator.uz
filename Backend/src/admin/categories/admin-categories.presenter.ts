import { Prisma, PartMainCategory } from '@prisma/client';

/**
 * Prisma `select` for a category node in the admin tree. `_count.parts` yields
 * the count of DIRECTLY-linked parts in the same read, so the whole tree costs
 * one query rather than one-per-node.
 */
export const ADMIN_CATEGORY_NODE_SELECT = {
  id: true,
  name: true,
  slug: true,
  parentId: true,
  level: true,
  sortOrder: true,
  iconKey: true,
  color: true,
  isActive: true,
  mainCategory: true,
  // Parts (buyer catalog) plus the supply-side listings and drafts that point
  // here. The delete guard needs all three: a category is only detachable when
  // nothing at all references it.
  _count: { select: { parts: true, products: true, drafts: true } },
} satisfies Prisma.PartCategorySelect;

export type AdminCategoryNodeRow = Prisma.PartCategoryGetPayload<{
  select: typeof ADMIN_CATEGORY_NODE_SELECT;
}>;

/** A category-tree node on the wire, with its nested children. */
export interface AdminCategoryTreeNode {
  id: string;
  name: string;
  slug: string | null;
  parentId: string | null;
  /** Derived depth: 0 = vehicle category, 1 = main category, 2 = subcategory. */
  level: number;
  sortOrder: number;
  iconKey: string | null;
  color: string | null;
  isActive: boolean;
  mainCategory: PartMainCategory | null;
  /** Buyer-catalog parts linked directly to this node. */
  productsCount: number;
  /** Supply-side listings + drafts pointing here (what blocks a hard delete). */
  listingsCount: number;
  children: AdminCategoryTreeNode[];
}

/** Flat wire node (no children) — the shape returned by the move/CRUD endpoints. */
export function presentAdminCategoryNode(
  row: AdminCategoryNodeRow,
): Omit<AdminCategoryTreeNode, 'children'> {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    parentId: row.parentId,
    level: row.level,
    sortOrder: row.sortOrder,
    iconKey: row.iconKey,
    color: row.color,
    isActive: row.isActive,
    mainCategory: row.mainCategory,
    productsCount: row._count.parts,
    listingsCount: row._count.products + row._count.drafts,
  };
}

/**
 * Assemble the flat rows into a nested forest. Roots (parentId == null, or a
 * parentId pointing outside the set) are top-level; children are ordered by
 * sortOrder then name, matching the read order. O(n).
 */
export function buildAdminCategoryTree(
  rows: AdminCategoryNodeRow[],
): AdminCategoryTreeNode[] {
  const byId = new Map<string, AdminCategoryTreeNode>();
  for (const row of rows) {
    byId.set(row.id, { ...presentAdminCategoryNode(row), children: [] });
  }

  const roots: AdminCategoryTreeNode[] = [];
  for (const row of rows) {
    const node = byId.get(row.id)!;
    const parent = row.parentId ? byId.get(row.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}
