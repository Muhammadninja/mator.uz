import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';
import { RedisKeys } from '../../redis/redis.keys';
import { CategoryAnchor } from './category-map';

/**
 * THE single place the dynamic PartCategory tree's rules live.
 *
 * The tree is admin-editable at runtime and is read by three very different
 * consumers — the admin console, the buyer catalog, and the Telegram seller bot
 * — so the rules that keep it well-formed (level derivation, cycle prevention,
 * lineage validation) must not be re-implemented per consumer. They live here.
 *
 * Levels are DERIVED, never accepted from a client:
 *   level 0 → Vehicle Category (root, parentId = null)
 *   level 1 → Main Category
 *   level 2 → Subcategory
 * Deeper nesting is structurally supported (a level is just parent.level + 1);
 * only these three are exposed by the wizard today.
 */
@Injectable()
export class PartCategoryService {
  /** Categories change rarely and are read on every wizard step. */
  private static readonly CACHE_TTL_SECONDS = 300;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  /**
   * Active root categories in display order — the bot's first category step.
   *
   * Filtered on level 0 AND parentId null, not on parentId alone: the internal
   * 'cat_uncategorized' fallback bucket is parentless but is not a taxonomy a
   * seller may choose, so it is parked at level 1 and excluded here.
   */
  async findRootCategories(): Promise<CategoryNode[]> {
    return this.cache.remember(
      RedisKeys.cacheReferenceCategories(),
      PartCategoryService.CACHE_TTL_SECONDS,
      () =>
        this.loadActive({
          parentId: null,
          level: 0,
          // The "Другое" root is reached by its own button, not from the
          // vehicle-category grid, so it is excluded here. It is otherwise an
          // ordinary category — findChildren('other') serves its admin-managed
          // children to the bot.
          excludeIds: [CategoryAnchor.OTHER],
        }),
    );
  }

  /**
   * The active children of the "Другое" root — the admin-managed catalogue the
   * bot lists when the seller leaves the spare-parts flow. Thin alias over
   * {@link findChildren} so the anchor id lives in one place; it shares the same
   * cache key and invalidation as any other parent's children.
   */
  async findOtherCategories(): Promise<CategoryNode[]> {
    return this.findChildren(CategoryAnchor.OTHER);
  }

  /**
   * The ACTIVE children of a category, in display order. An empty array is a
   * meaningful answer, not an error: it is exactly the signal the wizard uses to
   * skip the next selection step (see the empty-category rule).
   */
  async findChildren(parentId: string): Promise<CategoryNode[]> {
    return this.cache.remember(
      RedisKeys.cacheReferenceCategoryChildren(parentId),
      PartCategoryService.CACHE_TTL_SECONDS,
      () => this.loadActive({ parentId }),
    );
  }

  /** One category by id, or null. Not cached (used by write-path validation). */
  async findById(id: string): Promise<CategoryRow | null> {
    return this.prisma.partCategory.findUnique({
      where: { id },
      select: CATEGORY_SELECT,
    });
  }

  /** Like {@link findById} but 404s, for callers that require the row. */
  async getOrFail(id: string): Promise<CategoryRow> {
    const found = await this.findById(id);
    if (!found) throw new NotFoundException('Category not found');
    return found;
  }

  /** The whole forest as nested nodes. `activeOnly` filters both roots and children. */
  async findTree(activeOnly = false): Promise<TreeNode[]> {
    const rows = await this.prisma.partCategory.findMany({
      where: activeOnly ? { isActive: true } : {},
      orderBy: [{ level: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      select: CATEGORY_SELECT,
    });
    return buildTree(rows);
  }

  /**
   * The level a category would sit at under `parentId`, validating the parent
   * exists and is usable. Root (`null` parent) is level 0; otherwise
   * parent.level + 1. This is the ONLY way a level is ever produced — no caller
   * may pass one in.
   */
  async validateParent(parentId: string | null | undefined): Promise<number> {
    if (parentId == null) return 0;
    const parent = await this.findById(parentId);
    if (!parent) throw new NotFoundException('Parent category not found');
    if (parent.level + 1 > MAX_DEPTH) {
      throw new BadRequestException(
        `Category nesting is limited to ${MAX_DEPTH + 1} levels`,
      );
    }
    return parent.level + 1;
  }

  /**
   * Guard a re-parent: a category may not become its own parent, nor descend
   * under one of its own descendants (either would create a cycle). Returns the
   * new level so the caller writes a derived value.
   */
  async validateMove(id: string, parentId: string | null): Promise<number> {
    if (parentId === id) {
      throw new BadRequestException('A category cannot be its own parent');
    }
    const level = await this.validateParent(parentId);
    if (parentId != null) {
      const descendants = await this.descendantIds(id);
      if (descendants.has(parentId)) {
        throw new BadRequestException(
          'Cannot move a category under one of its own descendants',
        );
      }
    }
    return level;
  }

  /**
   * Verify a (vehicleCategoryId, categoryId) pair a CLIENT supplied is coherent
   * before it is persisted on a draft or product. This is the server-side
   * backstop for §26: it must hold even when the request bypasses the Telegram
   * UI entirely.
   *
   * Rules:
   *   • both ids must exist and be active;
   *   • the vehicle category must be a ROOT (level 0);
   *   • `categoryId` must be a DESCENDANT of `vehicleCategoryId` — walking up
   *     the parent chain from the category must reach the vehicle category.
   * A category equal to its own vehicle category is allowed (a root with no
   * children is a legitimate terminal choice).
   */
  async validateCategorySelection(
    vehicleCategoryId: string,
    categoryId: string,
  ): Promise<void> {
    const [vehicle, category] = await Promise.all([
      this.findById(vehicleCategoryId),
      this.findById(categoryId),
    ]);

    if (!vehicle) throw new NotFoundException('Vehicle category not found');
    if (!category) throw new NotFoundException('Category not found');
    if (!vehicle.isActive || !category.isActive) {
      throw new BadRequestException('Category is not active');
    }
    if (vehicle.parentId !== null || vehicle.level !== 0) {
      throw new BadRequestException(
        'vehicleCategoryId must be a root (level 0) category',
      );
    }
    if (!(await this.isDescendantOf(category, vehicleCategoryId))) {
      throw new BadRequestException(
        `Category "${categoryId}" does not belong to vehicle category "${vehicleCategoryId}"`,
      );
    }
  }

  /**
   * Drop every cached category payload. Called by ALL admin writes (create,
   * update, move, activate, deactivate, delete) so a taxonomy edit reaches the
   * seller bot on its next read rather than after the TTL.
   *
   * Children keys are per-parent, so a single edit could in principle leave a
   * sibling's key stale; deleting the roots key plus the affected parents' keys
   * covers every path the bot reads. `parentIds` are the parents touched by the
   * write (old and new, for a move).
   */
  async invalidate(...parentIds: (string | null | undefined)[]): Promise<void> {
    await this.cache.delete(RedisKeys.cacheReferenceCategories());
    const unique = new Set(parentIds.filter((p): p is string => !!p));
    await Promise.all(
      [...unique].map((p) =>
        this.cache.delete(RedisKeys.cacheReferenceCategoryChildren(p)),
      ),
    );
  }

  /**
   * Collect the ids of every descendant of `rootId`. One read of the (id,
   * parentId) edge set then a BFS in memory — the taxonomy is small, so this is
   * cheaper than a recursive CTE and easy to reason about.
   */
  async descendantIds(rootId: string): Promise<Set<string>> {
    const edges = await this.prisma.partCategory.findMany({
      select: { id: true, parentId: true },
    });
    const childrenOf = new Map<string, string[]>();
    for (const e of edges) {
      if (!e.parentId) continue;
      const list = childrenOf.get(e.parentId) ?? [];
      list.push(e.id);
      childrenOf.set(e.parentId, list);
    }

    const descendants = new Set<string>();
    const queue = [...(childrenOf.get(rootId) ?? [])];
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (descendants.has(next)) continue;
      descendants.add(next);
      const kids = childrenOf.get(next);
      if (kids) queue.push(...kids);
    }
    return descendants;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Walk up from `category` looking for `ancestorId`. Depth-bounded (no cycles). */
  private async isDescendantOf(
    category: CategoryRow,
    ancestorId: string,
  ): Promise<boolean> {
    let current: CategoryRow | null = category;
    for (let hops = 0; current && hops <= MAX_DEPTH + 1; hops++) {
      if (current.id === ancestorId) return true;
      if (!current.parentId) return false;
      current = await this.findById(current.parentId);
    }
    return false;
  }

  private async loadActive(where: {
    parentId: string | null;
    level?: number;
    excludeIds?: string[];
  }): Promise<CategoryNode[]> {
    const { excludeIds, ...scope } = where;
    const rows = await this.prisma.partCategory.findMany({
      where: {
        ...scope,
        isActive: true,
        ...(excludeIds?.length ? { id: { notIn: excludeIds } } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: CATEGORY_SELECT,
    });
    return rows.map(toNode);
  }
}

/**
 * Hard depth bound. The tree needs 3 levels today; the cap keeps an admin
 * mistake from producing a taxonomy the bot's keyboards cannot render, and
 * bounds the ancestor walk in {@link PartCategoryService.validateCategorySelection}.
 */
export const MAX_DEPTH = 4;

const CATEGORY_SELECT = {
  id: true,
  name: true,
  slug: true,
  parentId: true,
  level: true,
  sortOrder: true,
  isActive: true,
  // Fiscal configuration. Read by the seller bot at the moment a category is
  // TAPPED (findById — an uncached read) to decide whether the sale-form
  // question applies. Deliberately NOT carried into CategoryNode: that shape is
  // what gets cached in Redis and returned by the public reference API, so
  // adding fields there would change a cached payload and leak fiscal codes to
  // a public endpoint.
  mxik: true,
  packageCodeSingle: true,
  packageCodeSet: true,
} as const;

export interface CategoryRow {
  id: string;
  name: string;
  slug: string | null;
  parentId: string | null;
  level: number;
  sortOrder: number;
  isActive: boolean;
  mxik: string | null;
  packageCodeSingle: string | null;
  packageCodeSet: string | null;
}

/** The public (reference-API / bot) shape of one category. */
export interface CategoryNode {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  level: number;
  sortOrder: number;
}

export interface TreeNode extends CategoryNode {
  isActive: boolean;
  children: TreeNode[];
}

export function toNode(row: CategoryRow): CategoryNode {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug ?? row.id,
    parentId: row.parentId,
    level: row.level,
    sortOrder: row.sortOrder,
  };
}

/**
 * Nest a flat, level-ordered row list into a forest. A row whose parent is not
 * in the set (e.g. an inactive parent filtered out by `activeOnly`) is dropped
 * rather than promoted to a root — promoting it would misrepresent the tree.
 */
export function buildTree(rows: CategoryRow[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  for (const row of rows) {
    nodes.set(row.id, { ...toNode(row), isActive: row.isActive, children: [] });
  }
  const roots: TreeNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.id)!;
    if (row.parentId === null) {
      roots.push(node);
      continue;
    }
    nodes.get(row.parentId)?.children.push(node);
  }
  return roots;
}
