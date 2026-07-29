import {
  BadRequestException,
  ConflictException,
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
import { CreateCategoryDto } from './dto/create-category.dto';
import { MoveCategoryDto } from './dto/move-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

/** The synthetic fallback category — never deletable (parts always need a home). */
const UNCATEGORIZED_ID = 'cat_uncategorized';

/**
 * Admin/operator Category-tree manager. Backs /v1/admin/categories/* and the
 * bulk product-move over the EXISTING buyer catalog: PartCategory (the
 * relational category linked from CatalogPart.categoryId) and CatalogPart.
 *
 * PartCategory is now the SINGLE SOURCE OF TRUTH for the buyer grid: GET
 * /v1/categories reads the isActive rows whose mainCategory is set, with live
 * per-category counts (categories.service.ts). That endpoint is not cached
 * (counts are computed live per request), so writes here take effect on the
 * next read directly — there is no categories cache to bust.
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
   * Create a category. The id IS the slug (derived from an explicit slug, else
   * from the name), so a slug names one category. Validates parent existence and
   * slug/id uniqueness up front; the DB unique constraints are the backstop.
   */
  async create(dto: CreateCategoryDto) {
    const slug = this.slugify(dto.slug ?? dto.name);
    if (!slug) throw new BadRequestException('Could not derive a slug from name');

    const existing = await this.prisma.partCategory.findFirst({
      where: { OR: [{ id: slug }, { slug }] },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(`A category with slug "${slug}" already exists`);
    }

    if (dto.parentId != null) {
      const parent = await this.prisma.partCategory.findUnique({
        where: { id: dto.parentId },
        select: { id: true },
      });
      if (!parent) throw new NotFoundException('Parent category not found');
    }

    const created = await this.prisma.partCategory.create({
      data: {
        id: slug,
        name: dto.name,
        slug,
        iconKey: dto.iconKey ?? null,
        color: dto.color ?? null,
        sortOrder: dto.sortOrder ?? 0,
        mainCategory: dto.mainCategory ?? null,
        ...(dto.parentId != null
          ? { parent: { connect: { id: dto.parentId } } }
          : {}),
      },
      select: ADMIN_CATEGORY_NODE_SELECT,
    });

    return { success: true, data: presentAdminCategoryNode(created) };
  }

  /**
   * Update a category. Partial: only provided fields are written. A parentId
   * change reuses the cycle guard (parent = self or a descendant → 400). 404 if
   * the category is missing.
   */
  async update(id: string, dto: UpdateCategoryDto) {
    const category = await this.prisma.partCategory.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!category) throw new NotFoundException('Category not found');

    const data: Prisma.PartCategoryUpdateInput = {};

    if (dto.name !== undefined) data.name = dto.name;
    if (dto.iconKey !== undefined) data.iconKey = dto.iconKey;
    if (dto.color !== undefined) data.color = dto.color;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.mainCategory !== undefined) data.mainCategory = dto.mainCategory;

    if (dto.slug !== undefined) {
      const slug = this.slugify(dto.slug);
      if (!slug) throw new BadRequestException('Invalid slug');
      const clash = await this.prisma.partCategory.findFirst({
        where: { slug, NOT: { id } },
        select: { id: true },
      });
      if (clash) throw new ConflictException(`Slug "${slug}" is already in use`);
      data.slug = slug;
    }

    if (dto.parentId !== undefined) {
      const parentId = dto.parentId;
      if (parentId === null) {
        data.parent = { disconnect: true };
      } else {
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
        data.parent = { connect: { id: parentId } };
      }
    }

    const updated = await this.prisma.partCategory.update({
      where: { id },
      data,
      select: ADMIN_CATEGORY_NODE_SELECT,
    });

    return { success: true, data: presentAdminCategoryNode(updated) };
  }

  /**
   * Delete a category. If parts still reference it (categoryId is a Restrict FK),
   * a `reassignTo` target moves those parts first — both the move and the delete
   * run in one transaction. Without a target, a 409 lists the referencing count.
   * The fallback 'cat_uncategorized' bucket can never be deleted. 404 if missing.
   */
  async remove(id: string, reassignTo?: string) {
    if (id === UNCATEGORIZED_ID) {
      throw new ConflictException('The Uncategorized category cannot be deleted');
    }

    const category = await this.prisma.partCategory.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!category) throw new NotFoundException('Category not found');

    const referencing = await this.prisma.catalogPart.count({
      where: { categoryId: id },
    });

    if (referencing > 0) {
      if (!reassignTo) {
        throw new ConflictException(
          `Reassign ${referencing} product(s) first (pass ?reassignTo=<categoryId>)`,
        );
      }
      if (reassignTo === id) {
        throw new BadRequestException('reassignTo must be a different category');
      }
      const target = await this.prisma.partCategory.findUnique({
        where: { id: reassignTo },
        select: { id: true },
      });
      if (!target) throw new NotFoundException('Reassign target category not found');

      await this.prisma.$transaction([
        this.prisma.catalogPart.updateMany({
          where: { categoryId: id },
          data: { categoryId: reassignTo },
        }),
        this.prisma.partCategory.delete({ where: { id } }),
      ]);
      return { success: true, data: { deleted: id, reassigned: referencing } };
    }

    await this.prisma.partCategory.delete({ where: { id } });
    return { success: true, data: { deleted: id, reassigned: 0 } };
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
   * Deterministic slug: lowercase, non-alphanumerics → single dashes, trimmed.
   * Matches the id convention of the canonical rows ('oil-and-fluids', …) and is
   * capped at 64 chars (the PartCategory.id/varchar(64) bound). Empty in → empty
   * out, so callers reject an unslugifiable name.
   */
  private slugify(value: string): string {
    return value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64)
      .replace(/-+$/g, '');
  }

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
