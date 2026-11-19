import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AdminAuditAction,
  AdminAuditEntity,
  OilType,
  PackageForm,
  PartMainCategory,
  PartVehicleCategory,
  Prisma,
  ProductKind,
  SaleScopeType,
} from '@prisma/client';
import {
  categoryParentMap,
  decideListingMove,
  isLoadBearingCategory,
  mainCategoryForCategory,
  vehicleCategoryForCategory,
} from '../../catalog/categories/category-map';
import { PartCategoryService } from '../../catalog/categories/part-category.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  isCategoryFiscallyConfigured,
  packageFormGap,
} from '../../common/fiscal.util';
import { AdminAuditService } from '../auth/admin-audit.service';
import { AdminAuditContext } from '../auth/admin-auth.service';
import { categoryIsNodeBound } from '../fitment-studio/fitment-node.config';
import {
  ADMIN_CATEGORY_NODE_SELECT,
  LIVE_DRAFT_STATUSES,
  buildAdminCategoryTree,
  presentAdminCategoryNode,
} from './admin-categories.presenter';
import { AdminCategoryTransferService } from './admin-category-transfer.service';
import {
  translateCategoryDbErrors,
  writeCategoryTree,
} from './category-tree-lock';
import { BulkMoveProductsDto } from './dto/bulk-move-products.dto';
import { CreateCategoryDto } from './dto/create-category.dto';
import { ListCategoriesQueryDto } from './dto/list-categories.query.dto';
import { MoveCategoryDto } from './dto/move-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

/**
 * Why a delete was refused, as the machine-readable `code` of the 409. Each needs
 * a different answer from the operator, so the console must be able to tell them
 * apart:
 *   • HAS_PARTS / NEEDS_TARGET — something is filed in the subtree; picking a
 *     reassign target solves it (parts only / listings or drafts too);
 *   • HAS_LISTINGS — listings a transfer could not place, so they must be moved
 *     by hand first;
 *   • TREE_CHANGED — subcategories appeared while the delete was in flight;
 *   • HAS_SALES, PROTECTED — no target helps; deactivating does.
 * A transfer blocker (KIND_MISMATCH, TARGET_INACTIVE, …) may also come back when a
 * target was given: it is about that target, and another one may do.
 */
export const CategoryDeleteConflict = {
  PROTECTED: 'CATEGORY_PROTECTED',
  HAS_LISTINGS: 'CATEGORY_HAS_LISTINGS',
  HAS_PARTS: 'CATEGORY_HAS_PARTS',
  NEEDS_TARGET: 'CATEGORY_NEEDS_TARGET',
  HAS_SALES: 'CATEGORY_HAS_SALES',
  TREE_CHANGED: 'CATEGORY_TREE_CHANGED',
} as const;

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
  private readonly logger = new Logger(AdminCategoriesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly categories: PartCategoryService,
    private readonly audit: AdminAuditService,
    private readonly transfers: AdminCategoryTransferService,
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
    // Filtered after presenting: the status is the resolver's verdict, not a column.
    const data = rows
      .map(presentAdminCategoryNode)
      .filter(
        (node) =>
          query.fiscalStatus === undefined ||
          node.fiscalStatus === query.fiscalStatus,
      );
    return { success: true, data, meta: { total: data.length } };
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

    const updated = await translateCategoryDbErrors(() =>
      this.prisma.partCategory.update({
        where: { id },
        data: { isActive },
        select: ADMIN_CATEGORY_NODE_SELECT,
      }),
    );
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
    const parentId = dto.parentId;
    const { updated, previousParentId } = await this.writeTree(async (tx) => {
      const category = await tx.partCategory.findUnique({
        where: { id },
        select: { id: true, parentId: true },
      });
      if (!category) throw new NotFoundException('Category not found');

      // One guard for existence, self-parenting, cycles AND the depth cap; it
      // returns the DERIVED level so we never write a client-supplied one.
      const level = await this.categories.validateMove(id, parentId, tx);

      const data: Prisma.PartCategoryUpdateInput = {
        parent: parentId ? { connect: { id: parentId } } : { disconnect: true },
        level,
      };
      if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;

      const row = await tx.partCategory.update({
        where: { id },
        data,
        select: ADMIN_CATEGORY_NODE_SELECT,
      });

      // A moved subtree's descendants shift depth with it, so their stored levels
      // must follow — otherwise a level filter would report the old depth.
      await this.reindexDescendantLevels(id, level, tx);
      return { updated: row, previousParentId: category.parentId };
    });

    // Old parent, new parent, and the moved node itself (its own child list is
    // still cached under its id).
    await this.categories.invalidate(previousParentId, parentId, id);

    return { success: true, data: presentAdminCategoryNode(updated) };
  }

  /**
   * Create a category. The id IS the slug (derived from an explicit slug, else
   * from the name), so a slug names one category. Validates parent existence and
   * slug/id uniqueness up front; the DB unique constraints are the backstop.
   */
  async create(dto: CreateCategoryDto) {
    // Derived from the ENGLISH name when no slug is given: `slugify` keeps only
    // [a-z0-9], so a Russian or Uzbek-Cyrillic name would slugify to nothing.
    // nameEn is required, which is what makes this derivation always possible.
    const slug = this.slugify(dto.slug ?? dto.nameEn);
    if (!slug)
      throw new BadRequestException(
        'Could not derive a slug from nameEn — pass an explicit latin slug',
      );

    // A new category may arrive unconfigured, but never HALF-configured: the
    // combination is checked against an all-null baseline, since nothing is
    // stored yet.
    const fiscal = this.resolveFiscal(
      {
        mxik: null,
        packageCodeSingle: null,
        packageCodeSet: null,
        packageCodeBox: null,
      },
      dto,
    );

    const created = await this.writeTree(async (tx) => {
      const existing = await tx.partCategory.findFirst({
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
      const level = await this.categories.validateParent(dto.parentId, tx);
      await this.assertBucketFree(dto.mainCategory, slug, tx);

      return tx.partCategory.create({
        data: {
          id: slug,
          // `name` is internal: it defaults to the English name rather than
          // being a fourth thing an admin must keep in step.
          name: dto.name ?? dto.nameEn,
          nameRu: dto.nameRu,
          nameUz: dto.nameUz,
          nameEn: dto.nameEn,
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
    const { updated, previousParentId } = await this.writeTree(async (tx) => {
      const category = await tx.partCategory.findUnique({
        where: { id },
        // The fiscal columns are read too: a PARTIAL fiscal patch is only legal
        // in combination with what the row already holds ("add a set code to an
        // already-configured category"), so the check needs the current values.
        select: {
          id: true,
          slug: true,
          parentId: true,
          mxik: true,
          packageCodeSingle: true,
          packageCodeSet: true,
          packageCodeBox: true,
        },
      });
      if (!category) throw new NotFoundException('Category not found');

      const fiscal = this.resolveFiscal(category, dto);
      const data: Prisma.PartCategoryUpdateInput = { ...fiscal };

      if (dto.name !== undefined) data.name = dto.name;
      if (dto.nameRu !== undefined) data.nameRu = dto.nameRu;
      if (dto.nameUz !== undefined) data.nameUz = dto.nameUz;
      if (dto.nameEn !== undefined) data.nameEn = dto.nameEn;
      if (dto.iconKey !== undefined) data.iconKey = dto.iconKey;
      if (dto.color !== undefined) data.color = dto.color;
      if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
      if (dto.isActive !== undefined) data.isActive = dto.isActive;
      if (dto.mainCategory !== undefined) {
        await this.assertBucketFree(dto.mainCategory, id, tx);
        data.mainCategory = dto.mainCategory;
      }

      if (dto.slug !== undefined) {
        const slug = this.slugify(dto.slug);
        if (!slug) throw new BadRequestException('Invalid slug');
        if (slug !== category.slug) {
          // The application reaches these by id or by slug. Fitment Studio decides
          // what may bind to which vehicle node by slug, so renaming one would
          // quietly lift that check for its parts.
          if (
            isLoadBearingCategory(id) ||
            (category.slug && categoryIsNodeBound(category.slug))
          ) {
            throw new ConflictException({
              code: 'CATEGORY_SLUG_LOCKED',
              message: `The slug of "${id}" is used by the application and cannot be changed.`,
            });
          }
          // A slug names one category across both columns: the id IS the slug on
          // every row this console creates, so a slug equal to another row's id
          // would make a later create collide with something nobody can see.
          const clash = await tx.partCategory.findFirst({
            where: { OR: [{ slug }, { id: slug }], NOT: { id } },
            select: { id: true },
          });
          if (clash)
            throw new ConflictException(`Slug "${slug}" is already in use`);
        }
        data.slug = slug;
      }

      // A parent change here is the same operation as `move`, so it goes through
      // the same guard and derives the same level rather than duplicating rules.
      let movedLevel: number | undefined;
      if (dto.parentId !== undefined) {
        const parentId = dto.parentId;
        movedLevel = await this.categories.validateMove(id, parentId, tx);
        data.parent =
          parentId === null
            ? { disconnect: true }
            : { connect: { id: parentId } };
        data.level = movedLevel;
      }

      const row = await tx.partCategory.update({
        where: { id },
        data,
        select: ADMIN_CATEGORY_NODE_SELECT,
      });

      if (movedLevel !== undefined) {
        await this.reindexDescendantLevels(id, movedLevel, tx);
      }
      return { updated: row, previousParentId: category.parentId };
    });

    // Include the category's own key: a rename/deactivate changes what a seller
    // standing ON this node should see next.
    await this.categories.invalidate(previousParentId, dto.parentId, id);

    return { success: true, data: presentAdminCategoryNode(updated) };
  }

  /**
   * Delete a category together with every subcategory under it. The rows are
   * physically removed, there is no soft delete here (that is what deactivate is
   * for). 404 if missing.
   *
   * Whatever is filed anywhere in the subtree needs somewhere to go first, so
   * without a `reassignTo` target a 409 says what is there. With one, all in the
   * same transaction:
   *   • parts (categoryId is a Restrict FK) move under the operator-move rule,
   *     exactly as a bulk move would move them;
   *   • listings and live drafts (their FKs are ON DELETE SET NULL, so the database
   *     would strip them silently) move under the rules and blockers of a transfer;
   *   • finished drafts are history and only lose the FK.
   * A subtree holding a category the application depends on by id, or one that a
   * live sale targets, is refused outright.
   *
   * Every check and the delete run under the tree lock and a FOR UPDATE on each row
   * of the subtree. Inserting anything that references a category takes FOR KEY
   * SHARE on it, which FOR UPDATE blocks and waits for, so once the locks are held
   * no reference and no child can appear or be in flight unseen. Without them a
   * listing or child committed between a check and the delete would be silently
   * stripped by their ON DELETE SET NULL FKs.
   */
  async remove(id: string, reassignTo?: string, ctx: AdminAuditContext = {}) {
    if (isLoadBearingCategory(id)) {
      throw new ConflictException({
        code: CategoryDeleteConflict.PROTECTED,
        message:
          'The application depends on this category and it cannot be deleted. ' +
          'Deactivate it (POST /:id/deactivate) to hide it instead.',
      });
    }

    const result = await this.writeTree(async (tx) => {
      // No other tree write runs under the tree lock, so this shape holds. A writer
      // outside it is caught once the rows are locked, below.
      const layers = subtreeLayers(
        id,
        await tx.partCategory.findMany({
          select: { id: true, parentId: true },
        }),
      );
      const ids = layers.flat();
      const rows = await tx.$queryRaw<
        { id: string; parent_id: string | null; name: string }[]
      >`
        SELECT "id", "parent_id", "name" FROM "part_categories"
        WHERE "id" IN (${Prisma.join(ids)}) FOR UPDATE`;
      const category = rows.find((r) => r.id === id);
      if (!category) throw new NotFoundException('Category not found');

      const guarded = ids.find(isLoadBearingCategory);
      if (guarded) {
        throw new ConflictException({
          code: CategoryDeleteConflict.PROTECTED,
          message:
            `The application depends on the subcategory "${guarded}", so this ` +
            'category cannot be deleted. Move that subcategory out first, or ' +
            'deactivate this one (POST /:id/deactivate) to hide it.',
        });
      }

      // A child the operator never saw would be orphaned into a root by the parent
      // FK's SET NULL. Under the row locks none can be added any more.
      const unseen = await tx.partCategory.count({
        where: { parentId: { in: ids }, id: { notIn: ids } },
      });
      if (unseen > 0) {
        throw new ConflictException({
          code: CategoryDeleteConflict.TREE_CHANGED,
          message:
            'Subcategories were added here meanwhile. Reload the tree and try again.',
        });
      }

      // No FK can hold a sale target: the column points at three different tables.
      // So it is checked here, or the campaign would silently stop discounting while
      // still reading as live. A sale that has ended or was deleted is history.
      const sales = await tx.sale.findMany({
        where: {
          deletedAt: null,
          OR: [{ endAt: null }, { endAt: { gte: new Date() } }],
          targets: {
            some: {
              targetType: SaleScopeType.CATEGORIES,
              targetId: { in: ids },
            },
          },
        },
        select: { title: true },
      });
      if (sales.length > 0) {
        throw new ConflictException({
          code: CategoryDeleteConflict.HAS_SALES,
          message: `Sale(s) still target this category: ${sales
            .map((s) => s.title)
            .join(', ')}. Change or end them first.`,
        });
      }

      const pointingHere = {
        OR: [{ categoryId: { in: ids } }, { vehicleCategoryId: { in: ids } }],
      };
      const liveDrafts = {
        ...pointingHere,
        status: { in: LIVE_DRAFT_STATUSES },
      };
      const parts = await tx.catalogPart.count({
        where: { categoryId: { in: ids } },
      });
      const listings = await tx.product.count({ where: pointingHere });
      const drafts = await tx.productDraft.count({ where: liveDrafts });
      const supply = listings + drafts;

      if (parts + supply > 0 && !reassignTo) {
        throw new ConflictException(
          supply > 0
            ? {
                code: CategoryDeleteConflict.NEEDS_TARGET,
                message:
                  `Move ${parts} product(s) and ${supply} listing(s)/draft(s) to ` +
                  'another category first (pass ?reassignTo=<categoryId>)',
              }
            : {
                code: CategoryDeleteConflict.HAS_PARTS,
                message: `Reassign ${parts} product(s) first (pass ?reassignTo=<categoryId>)`,
              },
        );
      }

      const moved = { parts: 0, listings: 0, drafts: 0 };
      let target: { id: string; parentId: string | null } | null = null;
      if (parts + supply > 0) {
        if (ids.includes(reassignTo!)) {
          throw new BadRequestException(
            'reassignTo must be a category outside the one being deleted',
          );
        }
        target = await tx.partCategory.findUnique({
          where: { id: reassignTo },
          select: { id: true, parentId: true },
        });
        if (!target)
          throw new NotFoundException('Reassign target category not found');

        // A reassignment is a product move, so it writes the same filing as
        // bulk-move: the parts leave this category's tile as well as its id.
        if (parts > 0) {
          const filed = await tx.catalogPart.findMany({
            where: { categoryId: { in: ids } },
            select: { id: true, kind: true, oilType: true, categoryId: true },
          });
          const res = await this.moveParts(
            tx,
            filed,
            target,
            await this.filingOn(target.id, tx),
          );
          moved.parts = res.count;
        }

        if (supply > 0) {
          // Deepest first, though any order would do: moving a node's listings
          // also rewrites the root they name.
          for (const nodeId of [...ids].reverse()) {
            const res = await this.transfers.drainForDelete(
              tx,
              nodeId,
              target.id,
            );
            if (!res) continue;
            moved.listings += res.listings;
            moved.drafts += res.drafts;
          }
          // What a transfer cannot place (a listing whose own node has a broken
          // path) must not be stripped by the FK in its stead.
          const left =
            (await tx.product.count({ where: pointingHere })) +
            (await tx.productDraft.count({ where: liveDrafts }));
          if (left > 0) {
            throw new ConflictException({
              code: CategoryDeleteConflict.HAS_LISTINGS,
              message:
                `${left} listing(s)/draft(s) could not be moved automatically. ` +
                'Transfer them out of their subcategory first.',
            });
          }
        }
      }

      // Children before their parents: the parent FK is SET NULL, and a parent
      // removed first would turn the rest of the subtree into roots for a moment.
      for (const layer of [...layers].reverse()) {
        await tx.partCategory.deleteMany({ where: { id: { in: layer } } });
      }

      const reassignedTo = target?.id ?? null;
      const order = new Map(ids.map((nodeId, i) => [nodeId, i]));
      await this.audit.recordMany(
        [...rows]
          .sort((a, b) => order.get(a.id)! - order.get(b.id)!)
          .map((row) => ({
            action: AdminAuditAction.CATEGORY_DELETED,
            actor: ctx.actor,
            actorLabel: ctx.actorLabel,
            target: {
              entity: AdminAuditEntity.CATEGORY,
              id: row.id,
              name: row.name,
            },
            previousValues:
              row.id === id
                ? {
                    parentId: row.parent_id,
                    parts,
                    listings,
                    drafts,
                    subcategories: ids.length - 1,
                  }
                : { parentId: row.parent_id, deletedWith: id },
            newValues: { reassignedTo },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          })),
        tx,
      );
      return { parentId: category.parent_id, ids, moved, target };
    });

    const { parentId, ids, moved, target } = result;
    // Every row's own key too: a seller already past this step reads `children:<id>`.
    await this.categories.invalidate(
      parentId,
      ...ids,
      ...(target ? [target.id, target.parentId] : []),
    );
    this.logger.log(
      `Category ${id} deleted with ${ids.length - 1} subcategor(ies) ` +
        `(${moved.parts} part(s), ${moved.listings} listing(s), ${moved.drafts} draft(s) reassigned)`,
    );
    return {
      success: true,
      data: {
        deleted: id,
        reassigned: moved.parts,
        listings: moved.listings,
        drafts: moved.drafts,
        subcategories: ids.slice(1),
      },
    };
  }

  /**
   * Reassign many parts to one target category in a single transaction.
   * Validates the target exists; returns the number of rows moved and the
   * filing they now carry (`mainCategory: null` = on no home tile). A part that
   * cannot be filed there stops the whole batch (see moveParts). `dto.kind` is how
   * an operator states what a mis-typed part really is, which only they can know, and
   * `dto.packageForm` how it is sold, likewise.
   */
  async bulkMoveProducts(
    dto: BulkMoveProductsDto,
    ctx: AdminAuditContext = {},
  ) {
    const target = await this.prisma.partCategory.findUnique({
      where: { id: dto.targetCategoryId },
      select: {
        id: true,
        parentId: true,
        mxik: true,
        packageCodeSingle: true,
        packageCodeSet: true,
        packageCodeBox: true,
      },
    });
    if (!target) throw new NotFoundException('Target category not found');
    const formGap = dto.packageForm && packageFormGap(target, dto.packageForm);
    if (formGap) {
      throw new ConflictException({
        code: 'SALE_FORM_UNAVAILABLE',
        message: `These products cannot be stated as sold that way: ${formGap}.`,
      });
    }

    const filing = await this.filingOn(dto.targetCategoryId);
    // Within one transaction: either the whole batch moves or none does, and each
    // part that really changed is on the record. categoryId is a Restrict FK, so a
    // bad target would surface as a Prisma error — but we've already checked it
    // exists.
    const result = await translateCategoryDbErrors(() =>
      this.prisma.$transaction(async (tx) => {
        const before = await tx.catalogPart.findMany({
          where: { id: { in: dto.productIds } },
          select: {
            id: true,
            title: true,
            categoryId: true,
            kind: true,
            oilType: true,
            packageForm: true,
          },
        });
        const moved = await this.moveParts(
          tx,
          before,
          target,
          filing,
          dto.kind,
          dto.packageForm,
        );
        await this.audit.recordMany(
          before.flatMap((part) => {
            const oilType = moved.oilTypeOf.get(part.id);
            const previous = {
              ...(part.categoryId !== filing.categoryId
                ? { categoryId: part.categoryId }
                : {}),
              ...(dto.kind && dto.kind !== part.kind
                ? { kind: part.kind }
                : {}),
              ...(dto.packageForm && dto.packageForm !== part.packageForm
                ? { packageForm: part.packageForm }
                : {}),
              ...(oilType !== undefined ? { oilType: part.oilType } : {}),
            };
            if (Object.keys(previous).length === 0) return [];
            return {
              action: AdminAuditAction.CATALOG_PART_MOVED,
              actor: ctx.actor,
              actorLabel: ctx.actorLabel,
              target: {
                entity: AdminAuditEntity.CATALOG_PART,
                id: part.id,
                name: part.title.slice(0, 120),
              },
              previousValues: previous,
              newValues: {
                ...('categoryId' in previous
                  ? { categoryId: filing.categoryId }
                  : {}),
                ...('kind' in previous ? { kind: dto.kind } : {}),
                ...('packageForm' in previous
                  ? { packageForm: dto.packageForm }
                  : {}),
                ...(oilType !== undefined ? { oilType } : {}),
              },
              ip: ctx.ip,
              userAgent: ctx.userAgent,
            };
          }),
          tx,
        );
        return moved;
      }),
    );

    return { success: true, data: { moved: result.count, ...filing } };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /**
   * Write a move of these parts onto `target`, under the one rule every operator move
   * shares (decideListingMove). A part that cannot go there refuses the lot with a 409
   * rather than moving what it can: a half-done move leaves the operator guessing.
   *
   * The oil type is written only where it changes, so a move of ordinary parts touches
   * nothing but the filing. CatalogPart alone is written: the Product may be shared
   * across sellers, and the receipt reads this row.
   *
   * @returns how many rows moved, and the new oil type of each part that got one.
   */
  private async moveParts(
    tx: Prisma.TransactionClient,
    parts: {
      id: string;
      kind: ProductKind;
      oilType: OilType | null;
      categoryId: string;
    }[],
    target: { id: string; parentId: string | null },
    filing: Prisma.CatalogPartUncheckedUpdateManyInput,
    kind?: ProductKind,
    packageForm?: PackageForm,
  ): Promise<{ count: number; oilTypeOf: Map<string, OilType | null> }> {
    const sameType: string[] = [];
    const oilTypeOf = new Map<string, OilType | null>();
    const refusals: { code: string; message: string }[] = [];
    for (const part of parts) {
      const decision = decideListingMove(
        { ...part, kind: kind ?? part.kind },
        target,
      );
      if (!decision.ok) {
        refusals.push(decision);
        continue;
      }
      // An oil type means nothing on a part the operator says is no oil.
      const oilType =
        kind && kind !== ProductKind.MOTOR_OIL ? null : decision.oilType;
      if (oilType === part.oilType) sameType.push(part.id);
      else oilTypeOf.set(part.id, oilType);
    }
    if (refusals.length > 0) {
      throw new ConflictException({
        code: refusals[0].code,
        message: `${refusals.length} product(s) cannot move. ${refusals[0].message}`,
      });
    }

    const stated = {
      ...(kind ? { kind } : {}),
      ...(packageForm ? { packageForm } : {}),
    };
    let count = 0;
    if (sameType.length > 0) {
      const res = await tx.catalogPart.updateMany({
        where: { id: { in: sameType } },
        data: { ...filing, ...stated },
      });
      count += res.count;
    }
    for (const oilType of new Set(oilTypeOf.values())) {
      const res = await tx.catalogPart.updateMany({
        where: {
          id: {
            in: [...oilTypeOf]
              .filter(([, value]) => value === oilType)
              .map(([id]) => id),
          },
        },
        data: { ...filing, ...stated, oilType },
      });
      count += res.count;
    }
    return { count, oilTypeOf };
  }

  private writeTree<T>(
    write: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return writeCategoryTree(this.prisma, write);
  }

  /**
   * One home-grid bucket, one row. The grid serves every active row whose
   * mainCategory is set and counts parts by that enum, so a second row mirroring
   * a bucket is a duplicate tile showing the same parts.
   */
  private async assertBucketFree(
    mainCategory: PartMainCategory | null | undefined,
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (!mainCategory) return;
    const taken = await tx.partCategory.findFirst({
      where: { mainCategory, NOT: { id } },
      select: { id: true },
    });
    if (taken) {
      throw new ConflictException(
        `Category "${taken.id}" already mirrors ${mainCategory}`,
      );
    }
  }

  /**
   * The classification columns an operator's move writes onto a catalog part
   * filed on `categoryId` — and ONLY these, so price, stock, photos, fitment
   * and the fiscal data are never touched by a move.
   *
   * The home grid counts and lists by `mainCategory`, not by `categoryId`, so
   * moving the id alone left a part on its OLD tile. Both enums are re-derived
   * here from the live tree by id (category-map.ts — the rule the projection and
   * the backfill share), never kept from the old filing: a bucket assigned for
   * the previous category says nothing about the new one, and a target with no
   * home bucket (CATEGORIES_WITHOUT_MAIN_CATEGORY) correctly leaves every tile.
   */
  private async filingOn(
    categoryId: string,
    client: Pick<Prisma.TransactionClient, 'partCategory'> = this.prisma,
  ): Promise<{
    categoryId: string;
    mainCategory: PartMainCategory | null;
    vehicleCategory: PartVehicleCategory | null;
  }> {
    const parentOf = categoryParentMap(
      await client.partCategory.findMany({
        select: { id: true, parentId: true },
      }),
    );
    return {
      categoryId,
      mainCategory: mainCategoryForCategory(categoryId, parentOf),
      vehicleCategory: vehicleCategoryForCategory(categoryId, parentOf),
    };
  }

  /**
   * Resolve the fiscal columns a create/update must write, and REJECT any patch
   * that would leave the category half-configured.
   *
   * The rule is a property of the row AFTER the patch, not of the body, so it is
   * checked here rather than in the DTO (which can only see one field at a
   * time): a body that only adds `packageCodeSet` is perfectly valid for an
   * already-configured category and invalid for an empty one.
   *
   * The legal end states:
   *   • nothing set        — unconfigured; products of this category simply
   *                          cannot be paid for online until an admin fills it in;
   *   • mxik + ONE package code (single, set or box) — configured, sold in that one
   *     form; the seller is never asked how the item is sold;
   *   • mxik + several package codes — configured, sold in several forms; the seller
   *     bot asks which.
   * Anything else (an MXIK with no package code, a package code with no MXIK) is a
   * 400 — never a silently-stored partial.
   *
   * Returns ONLY the columns the body actually names, so an update that touches
   * no fiscal field writes none of them.
   */
  private resolveFiscal(
    current: {
      mxik: string | null;
      packageCodeSingle: string | null;
      packageCodeSet: string | null;
      packageCodeBox: string | null;
    },
    dto: {
      mxik?: string | null;
      packageCodeSingle?: string | null;
      packageCodeSet?: string | null;
      packageCodeBox?: string | null;
    },
  ): {
    mxik?: string | null;
    packageCodeSingle?: string | null;
    packageCodeSet?: string | null;
    packageCodeBox?: string | null;
  } {
    const touched =
      dto.mxik !== undefined ||
      dto.packageCodeSingle !== undefined ||
      dto.packageCodeSet !== undefined ||
      dto.packageCodeBox !== undefined;
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
    const packageCodeBox = pick(dto.packageCodeBox, current.packageCodeBox);

    const configured = isCategoryFiscallyConfigured({
      mxik,
      packageCodeSingle,
      packageCodeSet,
      packageCodeBox,
    });
    if (
      !configured &&
      (mxik || packageCodeSingle || packageCodeSet || packageCodeBox)
    ) {
      throw new BadRequestException(
        'Fiscal configuration is incomplete: a category needs mxik and at least ' +
          'one package code (packageCodeSingle, packageCodeSet or packageCodeBox). ' +
          'Clear them all to leave the category unconfigured.',
      );
    }

    // Only the named columns are returned; an untouched one keeps its value.
    return {
      ...(dto.mxik !== undefined ? { mxik } : {}),
      ...(dto.packageCodeSingle !== undefined ? { packageCodeSingle } : {}),
      ...(dto.packageCodeSet !== undefined ? { packageCodeSet } : {}),
      ...(dto.packageCodeBox !== undefined ? { packageCodeBox } : {}),
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
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const edges = await tx.partCategory.findMany({
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

      await tx.partCategory.updateMany({
        where: { id: { in: batch } },
        data: { level },
      });

      frontier = batch.flatMap((id) => childrenOf.get(id) ?? []);
      level += 1;
    }
  }
}

/**
 * `rootId` and every category under it, one array per depth: `[[root], [its
 * children], [theirs], …]`. A node already seen is not visited again, so a cycle
 * left by a writer outside the tree rules cannot loop forever.
 */
function subtreeLayers(
  rootId: string,
  edges: { id: string; parentId: string | null }[],
): string[][] {
  const childrenOf = new Map<string, string[]>();
  for (const e of edges) {
    if (!e.parentId) continue;
    const list = childrenOf.get(e.parentId) ?? [];
    list.push(e.id);
    childrenOf.set(e.parentId, list);
  }
  const seen = new Set<string>();
  const layers: string[][] = [];
  let layer = [rootId];
  while (layer.length > 0) {
    for (const nodeId of layer) seen.add(nodeId);
    layers.push(layer);
    layer = layer
      .flatMap((nodeId) => childrenOf.get(nodeId) ?? [])
      .filter((nodeId) => !seen.has(nodeId));
  }
  return layers;
}
