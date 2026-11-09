import { DraftStatus, Prisma, PartMainCategory } from '@prisma/client';
import {
  categoryFiscalReadiness,
  CategoryFiscalStatus,
  offersPackageChoice,
} from '../../common/fiscal.util';
import {
  isFiscalizedByOilType,
  isLoadBearingCategory,
} from '../../catalog/categories/category-map';

/**
 * Drafts that can still become a listing, and so genuinely depend on their
 * category. PUBLISHED / CANCELLED / EXPIRED rows are history: the sweep keeps
 * them forever, nothing reads their category again, and their FK is SET NULL. If
 * they counted, one abandoned draft would pin a category for good, with nothing
 * an operator could do about it.
 */
export const LIVE_DRAFT_STATUSES: DraftStatus[] = [
  DraftStatus.CREATING,
  DraftStatus.READY_FOR_PREVIEW,
  DraftStatus.COMMITTING,
];

/**
 * Prisma `select` for a category node in the admin tree. `_count.parts` yields
 * the count of DIRECTLY-linked parts in the same read, so the whole tree costs
 * one query rather than one-per-node.
 */
export const ADMIN_CATEGORY_NODE_SELECT = {
  id: true,
  name: true,
  // All three localized names — the console edits them as three inputs and
  // needs every one of them on read to populate the form.
  nameRu: true,
  nameUz: true,
  nameEn: true,
  slug: true,
  parentId: true,
  level: true,
  sortOrder: true,
  iconKey: true,
  color: true,
  isActive: true,
  mainCategory: true,
  // Fiscal configuration, so the console can show and edit it on every node.
  mxik: true,
  packageCodeSingle: true,
  packageCodeSet: true,
  packageCodeBox: true,
  // Parts (buyer catalog) plus the supply-side listings and live drafts that
  // point here, through either column. The same set the delete guard checks, so
  // what the console reports up front is what the server will answer. `children`
  // is the fiscal resolver's: active children are what make a node a parent.
  _count: {
    select: {
      parts: true,
      products: true,
      productsVehicle: true,
      drafts: { where: { status: { in: LIVE_DRAFT_STATUSES } } },
      draftsVehicle: { where: { status: { in: LIVE_DRAFT_STATUSES } } },
      children: { where: { isActive: true } },
    },
  },
} satisfies Prisma.PartCategorySelect;

export type AdminCategoryNodeRow = Prisma.PartCategoryGetPayload<{
  select: typeof ADMIN_CATEGORY_NODE_SELECT;
}>;

/** A category-tree node on the wire, with its nested children. */
export interface AdminCategoryTreeNode {
  id: string;
  /** Internal canonical label — not what the console displays to a user. */
  name: string;
  /** Display name in Russian (always present). */
  nameRu: string;
  /** Display name in Uzbek, Latin script (always present). */
  nameUz: string;
  /** Display name in English (always present). */
  nameEn: string;
  slug: string | null;
  parentId: string | null;
  /** Derived depth: 0 = vehicle category, 1 = main category, 2 = subcategory. */
  level: number;
  sortOrder: number;
  iconKey: string | null;
  color: string | null;
  isActive: boolean;
  mainCategory: PartMainCategory | null;
  // ── Фискальные данные ─────────────────────────────────────────────────────
  /** MXIK / ИКПУ (17 digits), or null while unconfigured. */
  mxik: string | null;
  /** Tasnif package code for "Штука". */
  packageCodeSingle: string | null;
  /** Tasnif package code for "Комплект / набор"; null when it is not sold that way. */
  packageCodeSet: string | null;
  /** Tasnif package code for "Потребительская коробка"; null when it is not sold that
   *  way. With one code in all, the seller is never asked how an item is sold. */
  packageCodeBox: string | null;
  /** Derived: whether products of this category can reach a receipt, by the same
   *  resolver Payme checkout runs. The console renders the warning off this rather than re-deriving the rule. */
  fiscalConfigured: boolean;
  /** Derived: this category's products are fiscalized from the oil table, so the
   *  code fields above are legitimately empty. True only on a composition category
   *  with no MXIK of its own: a code entered there is the one that gets used. */
  fiscalByOilType: boolean;
  /** Derived: what this category still needs, for working through the backlog. */
  fiscalStatus: CategoryFiscalStatus;
  /** Derived: every reason the resolver refuses this category; empty when ready. */
  fiscalGaps: string[];
  /** Derived: whether the seller bot asks how an item is sold here, which also means a
   *  listing that states no form cannot be paid for online. */
  offersPackageChoice: boolean;
  /** Buyer-catalog parts linked directly to this node. */
  productsCount: number;
  /** Supply-side listings + live drafts pointing here (what blocks a hard delete). */
  listingsCount: number;
  /** The application depends on this row by id: it can be deactivated, not deleted. */
  deleteProtected: boolean;
  children: AdminCategoryTreeNode[];
}

/** Flat wire node (no children) — the shape returned by the move/CRUD endpoints. */
export function presentAdminCategoryNode(
  row: AdminCategoryNodeRow,
): Omit<AdminCategoryTreeNode, 'children'> {
  const readiness = categoryFiscalReadiness(row);
  return {
    id: row.id,
    name: row.name,
    nameRu: row.nameRu,
    nameUz: row.nameUz,
    nameEn: row.nameEn,
    slug: row.slug,
    parentId: row.parentId,
    level: row.level,
    sortOrder: row.sortOrder,
    iconKey: row.iconKey,
    color: row.color,
    isActive: row.isActive,
    mainCategory: row.mainCategory,
    mxik: row.mxik,
    packageCodeSingle: row.packageCodeSingle,
    packageCodeSet: row.packageCodeSet,
    packageCodeBox: row.packageCodeBox,
    // Every flag comes from the shared rules, so the console, the seller bot and
    // the Payme builder can never disagree about what "configured" means.
    fiscalConfigured: readiness.status === 'READY',
    fiscalByOilType: isFiscalizedByOilType(row),
    fiscalStatus: readiness.status,
    fiscalGaps: readiness.gaps,
    offersPackageChoice: offersPackageChoice(row),
    productsCount: row._count.parts,
    // The larger of the two columns, not their sum: a listing filed on a childless
    // root carries the root in both, and must count once. The lineage rule makes
    // this exact (a category column on a root implies the vehicle column), and at
    // worst it understates a row without ever reporting a blocker that isn't one.
    listingsCount:
      Math.max(row._count.products, row._count.productsVehicle) +
      Math.max(row._count.drafts, row._count.draftsVehicle),
    deleteProtected: isLoadBearingCategory(row.id),
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
