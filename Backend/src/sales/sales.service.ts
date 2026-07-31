import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, SaleDiscountType, SaleScopeType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { clampLimit } from '../common/pagination.util';
import { IdPrefix, prefixedId } from '../common/ulid.util';
import { DiscountService } from './discount.service';
import { CreateSaleDto } from './dto/create-sale.dto';
import {
  ListSalesQueryDto,
  SaleSortField,
  SaleStatusFilter,
} from './dto/list-sales.query.dto';
import { UpdateSaleDto } from './dto/update-sale.dto';
import {
  SALE_DETAIL_SELECT,
  SALE_LIST_SELECT,
  presentPublicSale,
  presentSaleDetail,
  presentSaleRow,
} from './sales.presenter';

const DEFAULT_SALE_LIMIT = 20;
const MAX_SALE_LIMIT = 100;
/** Ceiling on the public list — a merchandising row, not a paginated console. */
const MAX_PUBLIC_SALES = 100;

/** Whitelist mapping an accepted sort field onto a real Prisma column. */
const SORT_COLUMN: Record<
  SaleSortField,
  keyof Prisma.SaleOrderByWithRelationInput
> = {
  createdAt: 'createdAt',
  startAt: 'startAt',
  endAt: 'endAt',
  title: 'title',
  priority: 'priority',
  discountValue: 'discountValue',
};

/**
 * Admin CRUD + the public read for sales. Owns validation and persistence; the
 * arithmetic and scope resolution live in DiscountService, so no controller and
 * no other module ever re-implements how a discount is computed.
 *
 * Kept small on purpose: the presenter owns projection, DiscountService owns
 * pricing, and this class owns only the request → row transitions.
 */
@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly discounts: DiscountService,
  ) {}

  // ── Admin ──────────────────────────────────────────────────────────────────

  async list(query: ListSalesQueryDto) {
    const page = query.page ?? 1;
    const limit = clampLimit(query.limit, DEFAULT_SALE_LIMIT, MAX_SALE_LIMIT);
    const sortField = query.sort ?? 'createdAt';
    const direction = query.order ?? 'desc';
    const now = new Date();

    // Soft-deleted sales are hidden by default; `includeDeleted=true` surfaces
    // them for the audit view. Set FIRST so nothing below can forget it.
    //
    // `status=deleted` implies it: asking for deleted sales is asking to see
    // them, and pinning deletedAt: null here would contradict the lifecycle
    // predicate below and silently return an empty page.
    const where: Prisma.SaleWhereInput = {};
    const includeDeleted =
      query.includeDeleted === 'true' || query.status === 'deleted';
    if (!includeDeleted) where.deletedAt = null;
    if (query.scopeType) where.scopeType = query.scopeType;
    if (query.isActive !== undefined)
      where.isActive = query.isActive === 'true';
    if (query.search) {
      where.title = { contains: query.search.trim(), mode: 'insensitive' };
    }
    // The lifecycle filter is a window predicate, not a column — see
    // saleLifecycle() in the presenter, which derives the same states for
    // display. Composed under AND rather than spread onto `where`: it carries
    // its own `isActive` and `OR`, either of which would silently overwrite the
    // filters above (`?isActive=false&status=active` must return nothing, not
    // quietly drop one of the two conditions).
    const lifecycle = this.lifecycleWhere(query.status, now);
    if (lifecycle) where.AND = [lifecycle];

    // The secondary `id` key makes the order total: without it, rows sharing a
    // createdAt (or a priority) could be returned in a different order per page
    // and a sale could be shown twice or skipped while paging.
    const orderBy: Prisma.SaleOrderByWithRelationInput[] = [
      { [SORT_COLUMN[sortField]]: direction },
      { id: 'asc' },
    ];

    const [sales, totalItems] = await this.prisma.$transaction([
      this.prisma.sale.findMany({
        where,
        select: SALE_LIST_SELECT,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.sale.count({ where }),
    ]);

    return {
      success: true,
      data: sales.map((sale) => presentSaleRow(sale, now)),
      meta: {
        page,
        limit,
        totalItems,
        totalPages: Math.ceil(totalItems / limit),
      },
    };
  }

  /**
   * A soft-deleted sale is treated as gone: 404, not a tombstone. The row still
   * exists for the audit view (`GET /v1/admin/sales?includeDeleted=true`), but
   * addressing it directly is indistinguishable from addressing a sale that
   * never existed.
   */
  async getOne(id: string) {
    const sale = await this.prisma.sale.findFirst({
      where: { id, deletedAt: null },
      select: SALE_DETAIL_SELECT,
    });
    if (!sale) throw new NotFoundException('Sale not found');
    return { success: true, data: presentSaleDetail(sale) };
  }

  /**
   * Create a sale and, for a scoped sale, its target rows — in one transaction,
   * so a sale can never be persisted with a half-written target set.
   */
  async create(dto: CreateSaleDto) {
    const scopeType = dto.scopeType ?? SaleScopeType.ALL_PRODUCTS;
    const startAt = new Date(dto.startAt);
    const endAt = dto.endAt ? new Date(dto.endAt) : null;

    this.assertWindow(startAt, endAt);
    this.assertDiscountValue(dto.discountType, dto.discountValue);
    const targetIds = this.resolveTargetIds(scopeType, dto.targetIds);
    await this.assertTargetsExist(scopeType, targetIds);

    const saleId = prefixedId(IdPrefix.SALE);
    const sale = await this.prisma.$transaction(async (tx) => {
      await tx.sale.create({
        data: {
          id: saleId,
          title: dto.title.trim(),
          description: dto.description?.trim() ?? null,
          discountType: dto.discountType,
          discountValue: new Prisma.Decimal(dto.discountValue),
          scopeType,
          startAt,
          endAt,
          isActive: dto.isActive ?? true,
          priority: dto.priority ?? 0,
          targets: {
            create: targetIds.map((targetId) => ({
              id: prefixedId(IdPrefix.SALE_TARGET),
              targetType: scopeType,
              targetId,
            })),
          },
        },
      });
      return tx.sale.findUniqueOrThrow({
        where: { id: saleId },
        select: SALE_DETAIL_SELECT,
      });
    });

    return { success: true, data: presentSaleDetail(sale) };
  }

  /**
   * Partial update. The DTO is the whitelist — with the global ValidationPipe's
   * `forbidNonWhitelisted`, a body naming anything else is already a 400.
   *
   * Cross-field rules are re-checked against the MERGED state (body over stored
   * row), not just the body, so neither "percent <= 100" nor "endAt >= startAt"
   * can be bypassed by splitting the change across two requests.
   *
   * A soft-deleted sale cannot be edited back to life — deletion is terminal,
   * so it 404s like any unknown id.
   */
  async update(id: string, dto: UpdateSaleDto) {
    const existing = await this.prisma.sale.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        discountType: true,
        discountValue: true,
        scopeType: true,
        startAt: true,
        endAt: true,
      },
    });
    if (!existing) throw new NotFoundException('Sale not found');

    if (Object.keys(dto).length === 0) {
      throw new BadRequestException('Nothing to update');
    }

    // Merge body over stored row before validating.
    const discountType = dto.discountType ?? existing.discountType;
    const discountValue =
      dto.discountValue ?? existing.discountValue.toNumber();
    const scopeType = dto.scopeType ?? existing.scopeType;
    const startAt = dto.startAt ? new Date(dto.startAt) : existing.startAt;
    const endAt =
      dto.endAt === undefined ? existing.endAt : new Date(dto.endAt);

    this.assertWindow(startAt, endAt);
    this.assertDiscountValue(discountType, discountValue);

    // Targets are replaced only when the caller says something about them —
    // either by sending `targetIds` or by changing the scope (which invalidates
    // the existing rows, since their targetType mirrors the scope).
    const scopeChanged = scopeType !== existing.scopeType;
    const replaceTargets = dto.targetIds !== undefined || scopeChanged;

    let targetIds: string[] = [];
    if (replaceTargets) {
      targetIds = this.resolveTargetIds(scopeType, dto.targetIds, {
        // On a scope change with no ids supplied, there is nothing sensible to
        // carry over — the old ids point at a different kind of thing.
        requireIdsFor: scopeChanged ? scopeType : undefined,
      });
      await this.assertTargetsExist(scopeType, targetIds);
    }

    const data: Prisma.SaleUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.description !== undefined) {
      data.description = dto.description?.trim() ?? null;
    }
    if (dto.discountType !== undefined) data.discountType = dto.discountType;
    if (dto.discountValue !== undefined) {
      data.discountValue = new Prisma.Decimal(dto.discountValue);
    }
    if (dto.scopeType !== undefined) data.scopeType = dto.scopeType;
    if (dto.startAt !== undefined) data.startAt = startAt;
    if (dto.endAt !== undefined) data.endAt = endAt;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.priority !== undefined) data.priority = dto.priority;

    const sale = await this.prisma.$transaction(async (tx) => {
      // Delete-then-recreate rather than diffing: a target set is small and
      // replacing it wholesale keeps the operation idempotent, inside the same
      // transaction as the sale update.
      if (replaceTargets) {
        await tx.saleTarget.deleteMany({ where: { saleId: id } });
        if (targetIds.length) {
          await tx.saleTarget.createMany({
            data: targetIds.map((targetId) => ({
              id: prefixedId(IdPrefix.SALE_TARGET),
              saleId: id,
              targetType: scopeType,
              targetId,
            })),
          });
        }
      }
      await tx.sale.update({ where: { id }, data });
      return tx.sale.findUniqueOrThrow({
        where: { id },
        select: SALE_DETAIL_SELECT,
      });
    });

    return { success: true, data: presentSaleDetail(sale) };
  }

  /**
   * SOFT delete: stamps `deletedAt` instead of removing the row. A campaign that
   * ran is part of the commercial record — which prices were advertised, and
   * when — so it stays on file and stays auditable. Its targets stay attached
   * rather than cascading away.
   *
   * Effect is immediate and total: a deleted sale is excluded from both lists
   * and from `activeWhere`, so it can never price anything again.
   *
   * Idempotent — deleting an already-deleted sale 404s rather than re-stamping,
   * so the timestamp always records the FIRST deletion.
   *
   * Past orders were never at risk either way: an OrderItem stores its own price
   * snapshot (priceUzs / lineTotalUzs) and holds no FK to a sale, so no order
   * total can change when a campaign ends. To pause a campaign you may still
   * want to run again, PATCH `isActive: false` — that is reversible; this is not.
   */
  async remove(id: string) {
    const existing = await this.prisma.sale.findUnique({
      where: { id },
      select: { id: true, deletedAt: true },
    });
    if (!existing || existing.deletedAt) {
      throw new NotFoundException('Sale not found');
    }

    await this.prisma.sale.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { success: true, data: { id, deleted: true } };
  }

  // ── Public ─────────────────────────────────────────────────────────────────

  /**
   * GET /v1/sales — the sales a buyer can currently benefit from.
   *
   * Activeness comes from DiscountService.activeWhere, the same predicate the
   * pricing path uses, so this list can never advertise a sale that pricing
   * would decline to apply (or hide one it would).
   */
  async listPublic() {
    const sales = await this.prisma.sale.findMany({
      where: this.discounts.activeWhere(),
      // DETAIL select (includes targets) so the public shape can carry targetIds.
      select: SALE_DETAIL_SELECT,
      orderBy: [{ priority: 'desc' }, { startAt: 'desc' }, { id: 'asc' }],
      take: MAX_PUBLIC_SALES,
    });
    return { items: sales.map(presentPublicSale) };
  }

  // ── Validation helpers ─────────────────────────────────────────────────────

  /** endAt, when present, must not precede startAt. */
  private assertWindow(startAt: Date, endAt: Date | null): void {
    if (Number.isNaN(startAt.getTime())) {
      throw new BadRequestException('startAt is not a valid date');
    }
    if (endAt && Number.isNaN(endAt.getTime())) {
      throw new BadRequestException('endAt is not a valid date');
    }
    if (endAt && endAt < startAt) {
      throw new BadRequestException(
        'endAt must be the same as or after startAt',
      );
    }
  }

  /**
   * discountValue > 0 always; <= 100 for a PERCENT sale. The DTO enforces this
   * when a body carries both fields; this covers the merged-state case where it
   * cannot (a PATCH that changes only one of the pair).
   */
  private assertDiscountValue(
    discountType: SaleDiscountType,
    discountValue: number,
  ): void {
    if (!Number.isFinite(discountValue) || discountValue <= 0) {
      throw new BadRequestException('discountValue must be greater than 0');
    }
    if (discountType === SaleDiscountType.PERCENT && discountValue > 100) {
      throw new BadRequestException(
        'discountValue must not exceed 100 for a PERCENT sale',
      );
    }
  }

  /**
   * Reconcile scope and targets: ALL_PRODUCTS takes none, every other scope
   * requires at least one. Returns the ids to persist (empty for ALL_PRODUCTS).
   */
  private resolveTargetIds(
    scopeType: SaleScopeType,
    targetIds: string[] | undefined,
    opts: { requireIdsFor?: SaleScopeType } = {},
  ): string[] {
    if (scopeType === SaleScopeType.ALL_PRODUCTS) {
      if (targetIds?.length) {
        throw new BadRequestException(
          'targetIds must be omitted when scopeType is ALL_PRODUCTS',
        );
      }
      return [];
    }

    if (!targetIds?.length) {
      // On an update that only re-scopes, the message names the real problem.
      if (opts.requireIdsFor) {
        throw new BadRequestException(
          `targetIds is required when changing scopeType to ${scopeType}`,
        );
      }
      throw new BadRequestException(
        `targetIds is required when scopeType is ${scopeType}`,
      );
    }

    // De-duplicate defensively; the unique index would reject repeats anyway.
    return [...new Set(targetIds.map((id) => id.trim()).filter(Boolean))];
  }

  /**
   * Every target id must name a row that exists. Without this a typo produces a
   * sale that silently discounts nothing — the failure mode hardest to notice
   * in production. One count query per create/update, not one per id.
   */
  private async assertTargetsExist(
    scopeType: SaleScopeType,
    targetIds: string[],
  ): Promise<void> {
    if (!targetIds.length) return;

    const found = await this.countExistingTargets(scopeType, targetIds);
    if (found === targetIds.length) return;

    throw new BadRequestException(
      `targetIds contains ${targetIds.length - found} id(s) that do not exist for scopeType ${scopeType}`,
    );
  }

  /**
   * How many of these ids exist, per scope kind. The one place scope maps onto
   * a table — a new scope kind adds a case here and nothing else changes.
   */
  private countExistingTargets(
    scopeType: SaleScopeType,
    ids: string[],
  ): Promise<number> {
    switch (scopeType) {
      case SaleScopeType.PRODUCTS:
        return this.prisma.catalogPart.count({ where: { id: { in: ids } } });
      case SaleScopeType.CATEGORIES:
        return this.prisma.partCategory.count({ where: { id: { in: ids } } });
      case SaleScopeType.DEALERS:
        return this.prisma.catalogSeller.count({ where: { id: { in: ids } } });
      default:
        // ALL_PRODUCTS never reaches here (resolveTargetIds returns []); an
        // unhandled new scope fails closed rather than accepting any id.
        throw new BadRequestException(
          `scopeType ${scopeType} does not support targetIds`,
        );
    }
  }

  /**
   * The lifecycle filter as a Prisma predicate. Mirrors saleLifecycle() in the
   * presenter, INCLUDING its precedence: `deleted` is terminal, `inactive` is
   * the switch being off, and the window states all require a live, enabled
   * sale. Every non-`deleted` state therefore pins `deletedAt: null` — otherwise
   * `?includeDeleted=true&status=scheduled` would list deleted sales as
   * scheduled, contradicting the `status: 'deleted'` the presenter puts on the
   * very same rows.
   */
  private lifecycleWhere(
    status: SaleStatusFilter | undefined,
    now: Date,
  ): Prisma.SaleWhereInput | null {
    switch (status) {
      case 'active':
        return this.discounts.activeWhere(now);
      case 'scheduled':
        return { deletedAt: null, isActive: true, startAt: { gt: now } };
      case 'expired':
        return { deletedAt: null, isActive: true, endAt: { lt: now } };
      case 'inactive':
        return { deletedAt: null, isActive: false };
      case 'deleted':
        return { deletedAt: { not: null } };
      default:
        return null;
    }
  }
}
