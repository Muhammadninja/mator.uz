import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PartCategoryService } from '../../catalog/categories/part-category.service';
import { PrismaService } from '../../prisma/prisma.service';
import { isCategoryFiscallyConfigured } from '../../common/fiscal.util';
import {
  ADMIN_CATEGORY_NODE_SELECT,
  buildAdminCategoryTree,
  presentAdminCategoryNode,
} from './admin-categories.presenter';
import { BulkMoveProductsDto } from './dto/bulk-move-products.dto';
import { CreateCategoryDto } from './dto/create-category.dto';
import { ListCategoriesQueryDto } from './dto/list-categories.query.dto';
import { MoveCategoryDto } from './dto/move-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

/** The synthetic fallback category — never deletable (parts always need a home). */
const UNCATEGORIZED_ID = 'cat_uncategorized';

/**
 * Admin/operator Category-tree manager. Backs /v1/admin/categories/* and the
 * bulk product-move over the EXISTING buyer catalog: PartCategory (the
 * relational category linked from CatalogPart.categoryId) and CatalogPart.
 *
 * PartCategory is now the SINGLE SOURCE OF TRUTH for the buyer grid AND for the
 * Telegram seller bot's category steps: GET /v1/categories reads the isActive
 * rows whose mainCategory is set with live per-category counts
 * (categories.service.ts), while the bot walks the tree through
 * /v1/reference/categories.
 *
 * The buyer-grid endpoint computes counts live per request, so it needs no
 * busting. The REFERENCE reads ARE cached, so every write here calls
 * `categories.invalidate(...)` with the parents it touched — that is what makes
 * an admin edit show up in the bot on the next tap instead of after the TTL.
 *
 * Hierarchy rules (level derivation, cycle prevention) are NOT reimplemented
 * here: they live in {@link PartCategoryService} so the bot, the buyer catalog
 * and this console cannot disagree about what a valid tree is.
 */
@Injectable()
export class AdminCategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly categories: PartCategoryService,
  ) {}

  /**
   * Flat, filtered listing. `parentId=null` (literal string) selects roots;
   * omitting it applies no parent filter at all.
   */
  async list(query: ListCategoriesQueryDto) {
    const where: Prisma.PartCategoryWhereInput = {};
    if (query.parentId !== undefined) {
      where.parentId = query.parentId === 'null' ? null : query.parentId;
    }
    if (query.level !== undefined) where.level = query.level;
    if (query.isActive !== undefined) where.isActive = query.isActive;

    const rows = await this.prisma.partCategory.findMany({
      where,
      select: ADMIN_CATEGORY_NODE_SELECT,
      orderBy: [{ level: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    });
    return {
      success: true,
      data: rows.map(presentAdminCategoryNode),
      meta: { total: rows.length },
    };
  }

  /** One category by id (flat node). 404 when missing. */
  async findOne(id: string) {
    const row = await this.prisma.partCategory.findUnique({
      where: { id },
      select: ADMIN_CATEGORY_NODE_SELECT,
    });
    if (!row) throw new NotFoundException('Category not found');
    return { success: true, data: presentAdminCategoryNode(row) };
  }

  /**
   * Hide a category from the buyer grid AND the seller bot without deleting it.
   * This is the PREFERRED removal path — referenced rows keep their history and
   * the change is reversible. Deactivating a parent hides its whole subtree from
   * the bot, since every reference read filters on isActive at each level.
   */
  async setActive(id: string, isActive: boolean) {
    const existing = await this.prisma.partCategory.findUnique({
      where: { id },
      select: { id: true, parentId: true },
    });
    if (!existing) throw new NotFoundException('Category not found');

    const updated = await this.prisma.partCategory.update({
      where: { id },
      data: { isActive },
      select: ADMIN_CATEGORY_NODE_SELECT,
    });
    // Both the parent's child list (where this row appears or disappears) AND
    // this row's OWN child list: a seller already past this step reads
    // `children:<id>`, so busting only the parent's key would let the bot keep
    // serving the children of a category that was just deactivated.
    await this.categories.invalidate(existing.parentId, id);
    return { success: true, data: presentAdminCategoryNode(updated) };
  }

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
      select: { id: true, parentId: true },
    });
    if (!category) throw new NotFoundException('Category not found');

    const parentId = dto.parentId;
    // One guard for existence, self-parenting, cycles AND the depth cap; it
    // returns the DERIVED level so we never write a client-supplied one.
    const level = await this.categories.validateMove(id, parentId);

    const data: Prisma.PartCategoryUpdateInput = {
      parent: parentId ? { connect: { id: parentId } } : { disconnect: true },
      level,
    };
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;

    const updated = await this.prisma.partCategory.update({
      where: { id },
      data,
      select: ADMIN_CATEGORY_NODE_SELECT,
    });

    // A moved subtree's descendants shift depth with it, so their stored levels
    // must follow — otherwise a level filter would report the old depth.
    await this.reindexDescendantLevels(id, level);
    // Old parent, new parent, and the moved node itself (its own child list is
    // still cached under its id).
    await this.categories.invalidate(category.parentId, parentId, id);

    return { success: true, data: presentAdminCategoryNode(updated) };
  }

  /**
   * Create a category. The id IS the slug (derived from an explicit slug, else
   * from the name), so a slug names one category. Validates parent existence and
   * slug/id uniqueness up front; the DB unique constraints are the backstop.
   */
  async create(dto: CreateCategoryDto) {
    const slug = this.slugify(dto.slug ?? dto.name);
    if (!slug)
      throw new BadRequestException('Could not derive a slug from name');

    const existing = await this.prisma.partCategory.findFirst({
      where: { OR: [{ id: slug }, { slug }] },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        `A category with slug "${slug}" already exists`,
      );
    }

    // Validates the parent exists and is within the depth cap, and DERIVES the
    // level (root → 0, else parent.level + 1). A client-sent level is never
    // accepted — the DTO does not even expose the field.
    const level = await this.categories.validateParent(dto.parentId);

    // A new category may arrive unconfigured, but never HALF-configured: the
    // combination is checked against an all-null baseline, since nothing is
    // stored yet.
    const fiscal = this.resolveFiscal(
      { mxik: null, packageCodeSingle: null, packageCodeSet: null },
      dto,
    );

    const created = await this.prisma.partCategory.create({
      data: {
        id: slug,
        name: dto.name,
        slug,
        level,
        iconKey: dto.iconKey ?? null,
        color: dto.color ?? null,
        sortOrder: dto.sortOrder ?? 0,
        mainCategory: dto.mainCategory ?? null,
        ...fiscal,
        ...(dto.parentId != null
          ? { parent: { connect: { id: dto.parentId } } }
          : {}),
      },
      select: ADMIN_CATEGORY_NODE_SELECT,
    });

    await this.categories.invalidate(dto.parentId);
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
      // The fiscal columns are read too: a PARTIAL fiscal patch is only legal
      // in combination with what the row already holds ("add a set code to an
      // already-configured category"), so the check needs the current values.
      select: {
        id: true,
        parentId: true,
        mxik: true,
        packageCodeSingle: true,
        packageCodeSet: true,
      },
    });
    if (!category) throw new NotFoundException('Category not found');

    const data: Prisma.PartCategoryUpdateInput = this.resolveFiscal(
      category,
      dto,
    );

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
      if (clash)
        throw new ConflictException(`Slug "${slug}" is already in use`);
      data.slug = slug;
    }

    // A parent change here is the same operation as `move`, so it goes through
    // the same guard and derives the same level rather than duplicating rules.
    let movedLevel: number | undefined;
    if (dto.parentId !== undefined) {
      const parentId = dto.parentId;
      movedLevel = await this.categories.validateMove(id, parentId);
      data.parent =
        parentId === null
          ? { disconnect: true }
          : { connect: { id: parentId } };
      data.level = movedLevel;
    }

    const updated = await this.prisma.partCategory.update({
      where: { id },
      data,
      select: ADMIN_CATEGORY_NODE_SELECT,
    });

    if (movedLevel !== undefined) {
      await this.reindexDescendantLevels(id, movedLevel);
    }
    // Include the category's own key: a rename/deactivate changes what a seller
    // standing ON this node should see next.
    await this.categories.invalidate(category.parentId, dto.parentId, id);

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
      throw new ConflictException(
        'The Uncategorized category cannot be deleted',
      );
    }

    const category = await this.prisma.partCategory.findUnique({
      where: { id },
      select: { id: true, parentId: true },
    });
    if (!category) throw new NotFoundException('Category not found');

    // Supply-side listings/drafts point here too. Their FKs are ON DELETE SET
    // NULL (a listing must never become unreadable), so the DB would NOT stop
    // the delete — it would silently strip those listings' category. Deleting a
    // referenced category is therefore rejected outright: deactivate it instead.
    const [listings, drafts, children] = await Promise.all([
      this.prisma.product.count({
        where: { OR: [{ categoryId: id }, { vehicleCategoryId: id }] },
      }),
      this.prisma.productDraft.count({
        where: { OR: [{ categoryId: id }, { vehicleCategoryId: id }] },
      }),
      this.prisma.partCategory.count({ where: { parentId: id } }),
    ]);

    if (listings + drafts > 0) {
      throw new ConflictException(
        `${listings + drafts} listing(s)/draft(s) reference this category. ` +
          'Deactivate it (POST /:id/deactivate) instead of deleting it.',
      );
    }
    if (children > 0) {
      throw new ConflictException(
        `This category has ${children} child categor(ies). Move or delete them first.`,
      );
    }

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
        throw new BadRequestException(
          'reassignTo must be a different category',
        );
      }
      const target = await this.prisma.partCategory.findUnique({
        where: { id: reassignTo },
        select: { id: true },
      });
      if (!target)
        throw new NotFoundException('Reassign target category not found');

      await this.prisma.$transaction([
        this.prisma.catalogPart.updateMany({
          where: { categoryId: id },
          data: { categoryId: reassignTo },
        }),
        this.prisma.partCategory.delete({ where: { id } }),
      ]);
      await this.categories.invalidate(category.parentId);
      return { success: true, data: { deleted: id, reassigned: referencing } };
    }

    await this.prisma.partCategory.delete({ where: { id } });
    await this.categories.invalidate(category.parentId);
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
   * Resolve the fiscal columns a create/update must write, and REJECT any patch
   * that would leave the category half-configured.
   *
   * The rule is a property of the row AFTER the patch, not of the body, so it is
   * checked here rather than in the DTO (which can only see one field at a
   * time): a body that only adds `packageCodeSet` is perfectly valid for an
   * already-configured category and invalid for an empty one.
   *
   * The three legal end states:
   *   • nothing set        — unconfigured; products of this category simply
   *                          cannot be paid for online until an admin fills it in;
   *   • mxik + single      — configured, sold in one form ("Штука"); the seller
   *                          is never asked how the item is sold;
   *   • mxik + single + set — configured, sold in two forms; the seller bot asks.
   * Anything else (a set code with no single code, an MXIK with no package code,
   * a package code with no MXIK) is a 400 — never a silently-stored partial.
   *
   * Returns ONLY the columns the body actually names, so an update that touches
   * no fiscal field writes none of them.
   */
  private resolveFiscal(
    current: {
      mxik: string | null;
      packageCodeSingle: string | null;
      packageCodeSet: string | null;
    },
    dto: {
      mxik?: string | null;
      packageCodeSingle?: string | null;
      packageCodeSet?: string | null;
    },
  ): {
    mxik?: string | null;
    packageCodeSingle?: string | null;
    packageCodeSet?: string | null;
  } {
    const touched =
      dto.mxik !== undefined ||
      dto.packageCodeSingle !== undefined ||
      dto.packageCodeSet !== undefined;
    if (!touched) return {};

    // Empty strings are treated as "clear", so a console sending a blank input
    // unconfigures the field instead of storing "".
    const pick = (
      next: string | null | undefined,
      stored: string | null,
    ): string | null => (next === undefined ? stored : next?.trim() || null);

    const mxik = pick(dto.mxik, current.mxik);
    const packageCodeSingle = pick(
      dto.packageCodeSingle,
      current.packageCodeSingle,
    );
    const packageCodeSet = pick(dto.packageCodeSet, current.packageCodeSet);

    const configured = isCategoryFiscallyConfigured({
      mxik,
      packageCodeSingle,
      packageCodeSet,
    });
    if (!configured && (mxik || packageCodeSingle || packageCodeSet)) {
      throw new BadRequestException(
        'Fiscal configuration is incomplete: a category needs BOTH mxik and ' +
          'packageCodeSingle (packageCodeSet is optional). Clear all three to ' +
          'leave the category unconfigured.',
      );
    }
    if (packageCodeSet && !configured) {
      throw new BadRequestException(
        'packageCodeSet requires mxik and packageCodeSingle',
      );
    }

    // Only the named columns are returned; an untouched one keeps its value.
    return {
      ...(dto.mxik !== undefined ? { mxik } : {}),
      ...(dto.packageCodeSingle !== undefined ? { packageCodeSingle } : {}),
      ...(dto.packageCodeSet !== undefined ? { packageCodeSet } : {}),
    };
  }

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
   * Re-derive the stored `level` of every descendant after `rootId` moved to
   * `rootLevel`. Walks down breadth-first, so each node's level is its parent's
   * plus one — the same rule create/move enforce. The taxonomy is small, so the
   * per-level updateMany is cheap and keeps the operation obvious.
   */
  private async reindexDescendantLevels(
    rootId: string,
    rootLevel: number,
  ): Promise<void> {
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

    let frontier = childrenOf.get(rootId) ?? [];
    let level = rootLevel + 1;
    const seen = new Set<string>([rootId]);
    while (frontier.length > 0) {
      const batch = frontier.filter((id) => !seen.has(id));
      if (batch.length === 0) break;
      for (const id of batch) seen.add(id);

      await this.prisma.partCategory.updateMany({
        where: { id: { in: batch } },
        data: { level },
      });

      frontier = batch.flatMap((id) => childrenOf.get(id) ?? []);
      level += 1;
    }
  }
}
