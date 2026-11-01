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
  DraftStatus,
  PackageForm,
  ProductKind,
  Prisma,
} from '@prisma/client';
import {
  CATEGORY_ID_TO_KIND,
  CategoryAnchor,
  categoryParentMap,
  isFiscalizedByOilType,
  mainCategoryForCategory,
  vehicleCategoryForCategory,
} from '../../catalog/categories/category-map';
import { PartCategoryService } from '../../catalog/categories/part-category.service';
import { isCategoryFiscallyConfigured } from '../../common/fiscal.util';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminAuditService } from '../auth/admin-audit.service';
import { AdminAuditContext } from '../auth/admin-auth.service';
import { LIVE_DRAFT_STATUSES } from './admin-categories.presenter';
import { writeCategoryTree } from './category-tree-lock';
import { TransferCategoryDto } from './dto/transfer-category.dto';

const TARGET_SELECT = {
  id: true,
  name: true,
  nameRu: true,
  nameUz: true,
  nameEn: true,
  parentId: true,
  level: true,
  isActive: true,
  mxik: true,
  packageCodeSingle: true,
  packageCodeSet: true,
} satisfies Prisma.PartCategorySelect;

type CategoryRow = Prisma.PartCategoryGetPayload<{
  select: typeof TARGET_SELECT;
}>;

/** A reason the transfer cannot run, or something the operator should know. */
export interface TransferIssue {
  code: string;
  message: string;
}

/**
 * Empties a category into another: the supply-side listings and live drafts as well
 * as the buyer-side parts, which is what `bulk-move` alone cannot do. It is how a
 * category with listings can eventually be deleted.
 *
 * Each column keeps its own meaning, because a part and its listing can legitimately
 * disagree, and no column is ever derived from another table:
 *   • catalog_parts.category_id — where the part is filed. Moved only for parts filed
 *     on the source, so a part an operator already moved elsewhere stays put.
 *   • products.category_id — the node the seller chose. Moved for listings on the
 *     source. Their main_category / vehicle_category enums follow the target, since
 *     an assigned enum wins over the tree at the next projection and would otherwise
 *     pull the part back to its old tile. A kind whose taxonomy is stated by the kind
 *     itself (oil, antifreeze) keeps its enums.
 *   • products.vehicle_category_id — the ROOT above that node, never chosen on its
 *     own: it is recomputed from wherever the node now is.
 *   • product_drafts — the same, for drafts that can still become a listing. Finished
 *     drafts are history. A sale form answered for the old category is cleared, as the
 *     wizard clears it whenever the chosen category changes.
 *
 * Prices, stock, photos, fitment and fiscal codes are not written. Fiscal codes live
 * on the category, so moving a listing changes which ones apply: the plan reports
 * that rather than hiding it.
 */
@Injectable()
export class AdminCategoryTransferService {
  private readonly logger = new Logger(AdminCategoryTransferService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly categories: PartCategoryService,
    private readonly audit: AdminAuditService,
  ) {}

  /** What a transfer would do, without doing it. */
  async preview(sourceId: string, targetId: string) {
    const plan = await this.plan(this.prisma, sourceId, targetId);
    return { success: true, data: this.present(plan) };
  }

  /**
   * Run the transfer in one transaction. The source row is locked first, so nothing
   * can start pointing at it unseen (see AdminCategoriesService.remove), and any
   * failure before commit leaves every row as it was.
   */
  async transfer(
    sourceId: string,
    dto: TransferCategoryDto,
    ctx: AdminAuditContext = {},
  ) {
    const result = await writeCategoryTree(this.prisma, async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "part_categories" WHERE "id" = ${sourceId} FOR UPDATE`;

      const plan = await this.plan(tx, sourceId, dto.targetCategoryId);
      if (plan.blockers.length > 0) {
        throw new ConflictException({
          code: plan.blockers[0].code,
          message: plan.blockers[0].message,
        });
      }
      const stale =
        (dto.expectedParts !== undefined &&
          dto.expectedParts !== plan.counts.parts) ||
        (dto.expectedListings !== undefined &&
          dto.expectedListings !== plan.counts.listings) ||
        (dto.expectedDrafts !== undefined &&
          dto.expectedDrafts !== plan.counts.liveDrafts);
      if (stale) {
        throw new ConflictException({
          code: 'TRANSFER_PREVIEW_STALE',
          message:
            'The category changed since the preview. Review the new numbers and try again.',
        });
      }

      const moved = await this.write(tx, plan);
      const remaining = await this.remainingOn(tx, sourceId);

      await this.audit.record(
        {
          action: AdminAuditAction.CATEGORY_ITEMS_TRANSFERRED,
          actor: ctx.actor,
          actorLabel: ctx.actorLabel,
          target: {
            entity: AdminAuditEntity.CATEGORY,
            id: sourceId,
            name: plan.source.name,
          },
          previousValues: { categoryId: sourceId, counts: plan.counts },
          newValues: {
            categoryId: plan.target.id,
            vehicleCategoryId: plan.targetRootId,
            moved,
            remaining,
          },
          reason: dto.reason,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        tx,
      );

      return { plan, moved, remaining };
    });

    await this.categories.invalidate(
      result.plan.source.parentId,
      result.plan.target.parentId,
      sourceId,
      result.plan.target.id,
    );
    this.logger.log(
      `Category ${sourceId} transferred to ${result.plan.target.id}: ${JSON.stringify(result.moved)}`,
    );

    return {
      success: true,
      data: {
        source: sourceId,
        target: result.plan.target.id,
        moved: result.moved,
        remaining: result.remaining,
      },
    };
  }

  // ── plan ───────────────────────────────────────────────────────────────────

  private async plan(
    client: Prisma.TransactionClient,
    sourceId: string,
    targetId: string,
  ) {
    if (sourceId === targetId) {
      throw new BadRequestException('Source and target must be different');
    }
    const [source, target, edges] = await Promise.all([
      client.partCategory.findUnique({
        where: { id: sourceId },
        select: TARGET_SELECT,
      }),
      client.partCategory.findUnique({
        where: { id: targetId },
        select: TARGET_SELECT,
      }),
      client.partCategory.findMany({
        select: { id: true, parentId: true, level: true, isActive: true },
      }),
    ]);
    if (!source) throw new NotFoundException('Category not found');
    if (!target) throw new NotFoundException('Target category not found');

    const parentOf = categoryParentMap(edges);
    const byId = new Map(edges.map((e) => [e.id, e]));
    const targetPath = pathToRoot(targetId, parentOf);
    const targetRootId = targetPath?.at(-1) ?? null;
    const rootOf = (id: string) => pathToRoot(id, parentOf)?.at(-1) ?? null;

    const onNode = { categoryId: sourceId };
    const viaRootOnly = {
      vehicleCategoryId: sourceId,
      OR: [{ categoryId: null }, { categoryId: { not: sourceId } }],
    };
    const movableDraft = {
      status: { in: [DraftStatus.CREATING, DraftStatus.READY_FOR_PREVIEW] },
    };

    const [
      parts,
      listings,
      listingKinds,
      partKinds,
      soldAsSet,
      rootOnlyListings,
      drafts,
      rootOnlyDrafts,
      committing,
      finishedDrafts,
      children,
      saleTargets,
    ] = await Promise.all([
      client.catalogPart.count({ where: onNode }),
      client.product.count({ where: onNode }),
      client.product.groupBy({
        by: ['kind'],
        where: onNode,
        _count: { _all: true },
      }),
      client.catalogPart.groupBy({
        by: ['kind'],
        where: onNode,
        _count: { _all: true },
      }),
      client.product.count({
        where: { ...onNode, packageForm: PackageForm.SET },
      }),
      client.product.groupBy({
        by: ['categoryId'],
        where: viaRootOnly,
        _count: { _all: true },
      }),
      client.productDraft.count({ where: { ...onNode, ...movableDraft } }),
      client.productDraft.groupBy({
        by: ['categoryId'],
        where: { ...viaRootOnly, ...movableDraft },
        _count: { _all: true },
      }),
      client.productDraft.count({
        where: {
          status: DraftStatus.COMMITTING,
          OR: [{ categoryId: sourceId }, { vehicleCategoryId: sourceId }],
        },
      }),
      client.productDraft.count({
        where: {
          status: { notIn: LIVE_DRAFT_STATUSES },
          OR: [{ categoryId: sourceId }, { vehicleCategoryId: sourceId }],
        },
      }),
      client.partCategory.count({ where: { parentId: sourceId } }),
      client.saleTarget.count({
        where: {
          targetType: 'CATEGORIES',
          targetId: sourceId,
          sale: { deletedAt: null },
        },
      }),
    ]);

    // A listing whose node hangs under this root belongs here: only its subcategory
    // moving would change that. The rest name this root by mistake, or have no node.
    const staleRoot = (
      groups: { categoryId: string | null; _count: { _all: number } }[],
    ) =>
      groups
        .filter((g) => !g.categoryId || rootOf(g.categoryId) !== sourceId)
        .reduce((n, g) => n + g._count._all, 0);
    const rootCorrections = staleRoot(rootOnlyListings);
    const draftRootCorrections = staleRoot(rootOnlyDrafts);

    const counts = {
      parts,
      listings,
      listingRootCorrections: rootCorrections,
      liveDrafts: drafts + draftRootCorrections,
      finishedDrafts,
      children,
      saleTargets,
    };

    const blockers: TransferIssue[] = [];
    const warnings: TransferIssue[] = [];

    // ── the target has to be somewhere a listing may legitimately be filed ──
    const inactive = targetPath?.find((id) => !byId.get(id)?.isActive);
    if (!targetPath) {
      blockers.push({
        code: 'TARGET_TREE_BROKEN',
        message: `The parents of "${targetId}" are broken in the category tree.`,
      });
    } else if (inactive) {
      blockers.push({
        code: 'TARGET_INACTIVE',
        message:
          inactive === targetId
            ? 'The target category is deactivated. Activate it first.'
            : `The target sits under the deactivated category "${inactive}".`,
      });
    }
    if (targetRootId && byId.get(targetRootId)?.level !== 0) {
      blockers.push({
        code: 'TARGET_NOT_A_CATEGORY',
        message:
          'The target is a fallback bucket, not a category sellers can list in.',
      });
    }

    // ── a listing's kind decides its questionnaire and how its receipt is coded ──
    const expectedKind = targetPath ? kindOfCategory(targetPath) : null;
    if (expectedKind) {
      const wrongKind = [...listingKinds, ...partKinds]
        .filter((g) => g.kind !== expectedKind)
        .reduce((n, g) => n + g._count._all, 0);
      if (wrongKind > 0) {
        blockers.push({
          code: 'KIND_MISMATCH',
          message: `${wrongKind} item(s) here are of a different kind than "${target.name}" holds (${expectedKind}).`,
        });
      }
    }

    // ── fiscal codes come from the category, so moving changes which apply ──
    const fiscallyReady = (c: CategoryRow) =>
      isFiscalizedByOilType(c) || isCategoryFiscallyConfigured(c);
    if (fiscallyReady(source) && !fiscallyReady(target)) {
      blockers.push({
        code: 'TARGET_NOT_FISCALIZED',
        message:
          'The target has no fiscal codes, so moved products could no longer be paid for online. Configure it first.',
      });
    } else if (
      source.mxik !== target.mxik ||
      source.packageCodeSingle !== target.packageCodeSingle
    ) {
      warnings.push({
        code: 'FISCAL_CODES_CHANGE',
        message:
          'Moved products will be fiscalized with the target category’s codes from now on.',
      });
    }
    if (soldAsSet > 0 && !target.packageCodeSet) {
      warnings.push({
        code: 'SET_FORM_FALLS_BACK',
        message: `${soldAsSet} listing(s) sold as a set will use the target’s single package code: it has no set code.`,
      });
    }

    // ── what would otherwise go wrong quietly ───────────────────────────────
    if (committing > 0) {
      blockers.push({
        code: 'DRAFT_COMMITTING',
        message: `${committing} draft(s) are being published right now. Try again in a moment.`,
      });
    }
    if (source.isActive) {
      warnings.push({
        code: 'SOURCE_STILL_ACTIVE',
        message:
          'The source is still active, so sellers can keep filing new listings on it. Deactivate it first if it is being retired.',
      });
    }
    if (children > 0) {
      warnings.push({
        code: 'SOURCE_HAS_CHILDREN',
        message: `${children} subcategor(ies) stay under the source with whatever they hold. Only what is filed directly on it moves.`,
      });
    }
    if (saleTargets > 0) {
      warnings.push({
        code: 'SALE_TARGETS_SOURCE',
        message: `${saleTargets} sale(s) target the source category. They will no longer discount what moves.`,
      });
    }

    return {
      source,
      target,
      targetPath,
      targetRootId,
      parentOf,
      counts,
      blockers,
      warnings,
      rootOf,
      rootOnlyListings,
      rootOnlyDrafts,
    };
  }

  private present(plan: Awaited<ReturnType<typeof this.plan>>) {
    const label = (c: CategoryRow) => ({
      id: c.id,
      name: c.name,
      nameRu: c.nameRu,
      nameUz: c.nameUz,
      nameEn: c.nameEn,
      isActive: c.isActive,
      parentId: c.parentId,
    });
    return {
      source: label(plan.source),
      target: { ...label(plan.target), path: plan.targetPath },
      counts: plan.counts,
      blockers: plan.blockers,
      warnings: plan.warnings,
      canTransfer: plan.blockers.length === 0,
    };
  }

  // ── write ──────────────────────────────────────────────────────────────────

  private async write(
    tx: Prisma.TransactionClient,
    plan: Awaited<ReturnType<typeof this.plan>>,
  ) {
    const { source, target, targetRootId, parentOf, rootOf } = plan;
    const main = mainCategoryForCategory(target.id, parentOf);
    const vehicle = vehicleCategoryForCategory(target.id, parentOf);
    const root = targetRootId!;

    const parts = await tx.catalogPart.updateMany({
      where: { categoryId: source.id },
      data: {
        categoryId: target.id,
        mainCategory: main,
        vehicleCategory: vehicle,
      },
    });

    const spareParts = await tx.product.updateMany({
      where: { categoryId: source.id, kind: ProductKind.SPARE_PART },
      data: {
        categoryId: target.id,
        vehicleCategoryId: root,
        mainCategory: main,
        vehicleCategory: vehicle,
      },
    });
    const otherKinds = await tx.product.updateMany({
      where: { categoryId: source.id, kind: { not: ProductKind.SPARE_PART } },
      data: { categoryId: target.id, vehicleCategoryId: root },
    });

    const liveDraft = {
      status: { in: [DraftStatus.CREATING, DraftStatus.READY_FOR_PREVIEW] },
    };
    const sparePartDrafts = await tx.productDraft.updateMany({
      where: {
        categoryId: source.id,
        kind: ProductKind.SPARE_PART,
        ...liveDraft,
      },
      data: {
        categoryId: target.id,
        vehicleCategoryId: root,
        category: vehicle,
        subcategory: main,
        packageForm: null,
      },
    });
    const otherKindDrafts = await tx.productDraft.updateMany({
      where: {
        categoryId: source.id,
        kind: { not: ProductKind.SPARE_PART },
        ...liveDraft,
      },
      data: {
        categoryId: target.id,
        vehicleCategoryId: root,
        packageForm: null,
      },
    });

    // Rows naming the source as their root without being under it: put right, each
    // to the root of its own node, or to the target's when it has none.
    let listingRoots = 0;
    for (const group of plan.rootOnlyListings) {
      const fixed = group.categoryId ? rootOf(group.categoryId) : root;
      if (!fixed || fixed === source.id) continue;
      const res = await tx.product.updateMany({
        where: { vehicleCategoryId: source.id, categoryId: group.categoryId },
        data: { vehicleCategoryId: fixed },
      });
      listingRoots += res.count;
    }
    let draftRoots = 0;
    for (const group of plan.rootOnlyDrafts) {
      const fixed = group.categoryId ? rootOf(group.categoryId) : root;
      if (!fixed || fixed === source.id) continue;
      const res = await tx.productDraft.updateMany({
        where: {
          vehicleCategoryId: source.id,
          categoryId: group.categoryId,
          ...liveDraft,
        },
        data: { vehicleCategoryId: fixed },
      });
      draftRoots += res.count;
    }

    return {
      parts: parts.count,
      listings: spareParts.count + otherKinds.count,
      listingRootCorrections: listingRoots,
      drafts: sparePartDrafts.count + otherKindDrafts.count + draftRoots,
    };
  }

  /** What still holds the source back from a delete, for the operator's next step. */
  private async remainingOn(tx: Prisma.TransactionClient, sourceId: string) {
    const pointingHere = {
      OR: [{ categoryId: sourceId }, { vehicleCategoryId: sourceId }],
    };
    const [parts, listings, drafts, children] = await Promise.all([
      tx.catalogPart.count({ where: { categoryId: sourceId } }),
      tx.product.count({ where: pointingHere }),
      tx.productDraft.count({
        where: { ...pointingHere, status: { in: LIVE_DRAFT_STATUSES } },
      }),
      tx.partCategory.count({ where: { parentId: sourceId } }),
    ]);
    return { parts, listings, drafts, children };
  }
}

/** From a node up to its root, or null on a missing parent or a cycle. */
function pathToRoot(
  id: string,
  parentOf: ReadonlyMap<string, string | null>,
): string[] | null {
  const path: string[] = [];
  let cursor: string | null | undefined = id;
  while (cursor) {
    if (path.includes(cursor) || !parentOf.has(cursor)) return null;
    path.push(cursor);
    cursor = parentOf.get(cursor);
  }
  return path;
}

/**
 * The kind of listing a category holds, from the same rules the seller bot applies
 * when a category is picked: a category that declares a kind, the antifreeze node,
 * and the "Другое" subtree, which runs the oil questionnaire. Anything else holds
 * spare parts.
 */
function kindOfCategory(pathFromNode: string[]): ProductKind {
  for (const id of pathFromNode) {
    if (Object.prototype.hasOwnProperty.call(CATEGORY_ID_TO_KIND, id)) {
      return CATEGORY_ID_TO_KIND[id];
    }
    if (id === CategoryAnchor.ANTIFREEZE) return ProductKind.ANTIFREEZE;
    if (id === CategoryAnchor.OTHER) return ProductKind.MOTOR_OIL;
  }
  return ProductKind.SPARE_PART;
}
