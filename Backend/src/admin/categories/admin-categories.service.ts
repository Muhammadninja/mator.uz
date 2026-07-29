import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ADMIN_CATEGORY_NODE_SELECT,
  buildAdminCategoryTree,
  presentAdminCategoryNode,
} from './admin-categories.presenter';
import { BulkMoveProductsDto } from './dto/bulk-move-products.dto';
import { MoveCategoryDto } from './dto/move-category.dto';

/**
 * Admin/operator Category-tree manager. Backs /v1/admin/categories/* and the
 * bulk product-move over the EXISTING buyer catalog: PartCategory (the
 * relational category linked from CatalogPart.categoryId) and CatalogPart.
 *
 * The mobile app's GET /v1/categories grid is served from hardcoded catalog
 * constants (categories.service.ts), NOT from this table, so there is no
 * reference cache to bust on a move — an edit here changes the relational
 * taxonomy the admin console and part↔category links use, and takes effect on
 * the next read directly.
 */
@Injectable()
export class AdminCategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Full nested category tree, each node carrying its direct products count. */
  async tree() {
    const rows = await this.prisma.partCategory.findMany({
      select: ADMIN_CATEGORY_NODE_SELECT,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return { success: true, data: buildAdminCategoryTree(rows) };
  }

  /**
   * Move a category under a new parent (or to root) and, optionally, set its
   * sibling order. Rejects a move whose parent is the category itself or any of
   * its descendants (would create a cycle) with 400.
   */
  async move(id: string, dto: MoveCategoryDto) {
    const category = await this.prisma.partCategory.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!category) throw new NotFoundException('Category not found');

    const parentId = dto.parentId;
    if (parentId !== null) {
      if (parentId === id) {
        throw new BadRequestException('A category cannot be its own parent');
      }
      const parent = await this.prisma.partCategory.findUnique({
        where: { id: parentId },
        select: { id: true },
      });
      if (!parent) throw new NotFoundException('Target parent category not found');

      const descendants = await this.descendantIds(id);
      if (descendants.has(parentId)) {
        throw new BadRequestException(
          'Cannot move a category under one of its own descendants',
        );
      }
    }

    const data: Prisma.PartCategoryUpdateInput = {
      parent: parentId
        ? { connect: { id: parentId } }
        : { disconnect: true },
    };
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;

    const updated = await this.prisma.partCategory.update({
      where: { id },
      data,
      select: ADMIN_CATEGORY_NODE_SELECT,
    });

    return { success: true, data: presentAdminCategoryNode(updated) };
  }

  /**
   * Reassign many parts to one target category in a single transaction.
   * Validates the target exists; returns the number of rows moved.
   */
  async bulkMoveProducts(dto: BulkMoveProductsDto) {
    const target = await this.prisma.partCategory.findUnique({
      where: { id: dto.targetCategoryId },
      select: { id: true },
    });
    if (!target) throw new NotFoundException('Target category not found');

    // updateMany over the id set within one transaction: either the whole batch
    // moves or none does. categoryId is a Restrict FK, so a bad target would
    // surface as a Prisma error — but we've already checked it exists.
    const [result] = await this.prisma.$transaction([
      this.prisma.catalogPart.updateMany({
        where: { id: { in: dto.productIds } },
        data: { categoryId: dto.targetCategoryId },
      }),
    ]);

    return { success: true, data: { moved: result.count } };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /**
   * Collect the ids of every descendant of `rootId` (transitive children).
   * One read of the (id, parentId) edge set, then a BFS in memory — the tree is
   * small (a fixed taxonomy), so this is cheap and avoids a recursive CTE.
   */
  private async descendantIds(rootId: string): Promise<Set<string>> {
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
    const queue: string[] = [...(childrenOf.get(rootId) ?? [])];
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (descendants.has(next)) continue;
      descendants.add(next);
      const kids = childrenOf.get(next);
      if (kids) queue.push(...kids);
    }
    return descendants;
  }
}
