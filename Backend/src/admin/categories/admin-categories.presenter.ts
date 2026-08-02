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
  sortOrder: true,
  iconKey: true,
  color: true,
  isActive: true,
  mainCategory: true,
  // parts = buyer-catalog rows (productsCount, reassignable on delete);
  // products + productDrafts = supply-side listings (listingsCount) that steer an
  // admin toward deactivate over a hard delete.
  _count: { select: { parts: true, products: true, productDrafts: true } },
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
  /** Depth in the tree — 0 = root, 1 = main, 2 = subcategory. DERIVED from the
   *  parent chain (there is no stored column); assigned during tree assembly.
   *  Flat CRUD responses report 0 as a placeholder — the authoritative value
   *  comes from the tree read the client refetches after a write. */
  level: number;
  sortOrder: number;
  iconKey: string | null;
  color: string | null;
  isActive: boolean;
  mainCategory: PartMainCategory | null;
  productsCount: number;
  /** Supply-side products + drafts that chose this category. `> 0` steers an
   *  admin toward deactivate — a hard delete would strand live listings. */
  listingsCount: number;
  children: AdminCategoryTreeNode[];
}

/** Flat wire node (no children) — the shape returned by the move/CRUD endpoints.
 *  `level` defaults to 0 for the flat responses (see the field's note); the tree
 *  builder passes the real depth. */
export function presentAdminCategoryNode(
  row: AdminCategoryNodeRow,
  level = 0,
): Omit<AdminCategoryTreeNode, 'children'> {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    parentId: row.parentId,
    level,
    sortOrder: row.sortOrder,
    iconKey: row.iconKey,
    color: row.color,
    isActive: row.isActive,
    mainCategory: row.mainCategory,
    productsCount: row._count.parts,
    listingsCount: row._count.products + row._count.productDrafts,
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

  // Assign `level` by depth from the roots (no stored column). A DFS after the
  // forest is built handles rows arriving in any order.
  const assignLevel = (node: AdminCategoryTreeNode, level: number) => {
    node.level = level;
    for (const child of node.children) assignLevel(child, level + 1);
  };
  for (const root of roots) assignLevel(root, 0);

  return roots;
}
