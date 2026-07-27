import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AdminAuditAction,
  AdminAuditEntity,
  DealerStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { clampLimit } from '../../common/pagination.util';
import { AdminAuditContext } from '../auth/admin-auth.service';
import { AdminAuditService } from '../auth/admin-audit.service';
import {
  ADMIN_DEALER_DETAIL_SELECT,
  ADMIN_DEALER_LIST_SELECT,
  presentAdminDealerDetail,
  presentAdminDealerRow,
} from './admin-dealers.presenter';
import {
  AdminDealerSortField,
  AdminDealerStatusFilter,
  ListAdminDealersQueryDto,
} from './dto/list-admin-dealers.query.dto';
import { UpdateAdminDealerDto } from './dto/update-admin-dealer.dto';

const DEFAULT_ADMIN_DEALER_LIMIT = 20;
const MAX_ADMIN_DEALER_LIMIT = 100;
// Minimum digits before a search term is treated as a (partial) phone number —
// same threshold as the orders and users consoles.
const MIN_PHONE_SEARCH_DIGITS = 4;

/** Wire vocabulary → the real DealerStatus enum. */
const STATUS_BY_WIRE: Record<AdminDealerStatusFilter, DealerStatus> = {
  active: DealerStatus.ACTIVE,
  pending: DealerStatus.PENDING,
  suspended: DealerStatus.SUSPENDED,
};

/**
 * Whitelist mapping the accepted sort field onto the real Prisma column.
 * `skus` has no column of its own — it is a relation count — so it sorts via
 * Prisma's `_count` ordering rather than a scalar, and is handled separately.
 */
const SORT_COLUMN: Record<
  Exclude<AdminDealerSortField, 'skus'>,
  keyof Prisma.CatalogSellerOrderByWithRelationInput
> = {
  joinedAt: 'joinedAt',
  name: 'name',
  gmvUzs: 'gmvUzs',
  orders: 'ordersCount',
};

/** The editable-field mutations, and the audit verb each one records. */
const BADGE_ACTIONS = {
  certified: {
    on: AdminAuditAction.DEALER_CERTIFIED_ENABLED,
    off: AdminAuditAction.DEALER_CERTIFIED_DISABLED,
  },
  lowestPrice: {
    on: AdminAuditAction.DEALER_LOWEST_PRICE_ENABLED,
    off: AdminAuditAction.DEALER_LOWEST_PRICE_DISABLED,
  },
} as const;

/**
 * Admin/operator dealer console. Backs /v1/admin/dealers: the moderation queue
 * and the certified/lowest-price badges over the CatalogSeller table — the same
 * rows the public GET /v1/dealers storefront reads, so a change here is
 * immediately visible to the buyer-facing catalog.
 *
 * Every mutation is audited, and the audit entry is written INSIDE the same
 * transaction as the change (AdminAuditService.record takes the `tx`). A dealer
 * can therefore never be suspended without a record of who did it, and a rolled
 * back change leaves no misleading entry.
 *
 * State machine — the only legal transitions:
 *   PENDING   → ACTIVE     (approve)
 *   ACTIVE    → SUSPENDED  (suspend)
 *   SUSPENDED → ACTIVE     (reactivate)
 * Anything else is a 400. The transitions are checked against the row read in
 * the same transaction, so two concurrent approvals cannot both succeed.
 */
@Injectable()
export class AdminDealersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  async list(query: ListAdminDealersQueryDto) {
    const page = query.page ?? 1;
    const limit = clampLimit(
      query.limit,
      DEFAULT_ADMIN_DEALER_LIMIT,
      MAX_ADMIN_DEALER_LIMIT,
    );
    const sortField = query.sort ?? 'joinedAt';
    const direction = query.order ?? 'desc';

    const where: Prisma.CatalogSellerWhereInput = {};
    if (query.status) where.status = STATUS_BY_WIRE[query.status];
    const search = this.buildSearch(query.search);
    if (search) where.OR = search;

    // Newest dealers first by default. The secondary `id` key makes the order
    // total: without it, rows sharing a joinedAt (every row backfilled by the
    // migration shares one) could be returned in a different order per page and
    // a dealer could be shown twice or skipped while paging.
    const orderBy: Prisma.CatalogSellerOrderByWithRelationInput[] =
      sortField === 'skus'
        ? [{ parts: { _count: direction } }, { id: 'asc' }]
        : [{ [SORT_COLUMN[sortField]]: direction }, { id: 'asc' }];

    const [dealers, totalItems] = await this.prisma.$transaction([
      this.prisma.catalogSeller.findMany({
        where,
        select: ADMIN_DEALER_LIST_SELECT,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.catalogSeller.count({ where }),
    ]);

    return {
      success: true,
      data: dealers.map(presentAdminDealerRow),
      meta: {
        page,
        limit,
        totalItems,
        totalPages: Math.ceil(totalItems / limit),
      },
    };
  }

  async getOne(id: string) {
    const dealer = await this.prisma.catalogSeller.findUnique({
      where: { id },
      select: ADMIN_DEALER_DETAIL_SELECT,
    });
    if (!dealer) throw new NotFoundException('Dealer not found');
    return { success: true, data: presentAdminDealerDetail(dealer) };
  }

  /**
   * Update the editable fields. The DTO is the whitelist — with the global
   * ValidationPipe's `forbidNonWhitelisted`, a body naming anything else is
   * already rejected with 400 before reaching here.
   *
   * Each changed field produces its OWN audit entry with the specific verb
   * ("certified enabled", "lowest-price disabled"), so the trail reads as what
   * actually happened rather than a generic "updated". A field set to the value
   * it already holds is not a change and is not audited.
   */
  async update(id: string, dto: UpdateAdminDealerDto, ctx: AdminAuditContext) {
    if (
      dto.certified === undefined &&
      dto.lowestPrice === undefined &&
      dto.status === undefined
    ) {
      throw new BadRequestException('Nothing to update');
    }

    await this.prisma.$transaction(async (tx) => {
      const dealer = await this.requireDealer(tx, id);

      const data: Prisma.CatalogSellerUpdateInput = {};
      const entries: Array<{
        action: AdminAuditAction;
        previousValues: Prisma.InputJsonValue;
        newValues: Prisma.InputJsonValue;
      }> = [];

      for (const field of ['certified', 'lowestPrice'] as const) {
        const next = dto[field];
        if (next === undefined || next === dealer[field]) continue;
        data[field] = next;
        entries.push({
          action: next ? BADGE_ACTIONS[field].on : BADGE_ACTIONS[field].off,
          previousValues: { [field]: dealer[field] },
          newValues: { [field]: next },
        });
      }

      if (dto.status !== undefined) {
        const next = STATUS_BY_WIRE[dto.status];
        if (next !== dealer.status) {
          // Routed through the same transition table the dedicated endpoints
          // use, so PATCH cannot reach a state they forbid (e.g. straight from
          // PENDING to SUSPENDED).
          this.assertTransition(dealer.status, next);
          data.status = next;
          data.suspendedReason =
            next === DealerStatus.SUSPENDED ? (dto.reason?.trim() ?? null) : null;
          entries.push({
            action: auditActionFor(dealer.status, next),
            previousValues: { status: dealer.status },
            newValues: { status: next },
          });
        }
      }

      // Every field arrived already holding the requested value: no write, and
      // nothing to audit. Returning early keeps the trail free of no-op entries.
      if (entries.length === 0) return;

      await tx.catalogSeller.update({ where: { id }, data });
      for (const entry of entries) {
        await this.recordDealerAudit(tx, {
          ...entry,
          dealer,
          ctx,
          reason: data.status === DealerStatus.SUSPENDED ? dto.reason : null,
        });
      }
    });

    return this.getOne(id);
  }

  /** PENDING → ACTIVE. Any other current status is a 400. */
  async approve(id: string, ctx: AdminAuditContext) {
    return this.transition(id, DealerStatus.ACTIVE, ctx);
  }

  /** ACTIVE → SUSPENDED, persisting the reason. */
  async suspend(id: string, ctx: AdminAuditContext, reason?: string) {
    return this.transition(id, DealerStatus.SUSPENDED, ctx, reason);
  }

  /** SUSPENDED → ACTIVE, clearing the suspension reason. */
  async reactivate(id: string, ctx: AdminAuditContext) {
    return this.transition(id, DealerStatus.ACTIVE, ctx);
  }

  /**
   * The one write path for a status change. Reads the dealer, checks the
   * transition and writes the row + its audit entry in a single transaction, so
   * two concurrent approvals cannot both observe PENDING and both succeed.
   */
  private async transition(
    id: string,
    next: DealerStatus,
    ctx: AdminAuditContext,
    reason?: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const dealer = await this.requireDealer(tx, id);
      this.assertTransition(dealer.status, next);

      const trimmedReason =
        next === DealerStatus.SUSPENDED ? (reason?.trim() ?? null) : null;

      await tx.catalogSeller.update({
        where: { id },
        data: {
          status: next,
          // Cleared on any non-suspending transition, so a reactivated dealer
          // never carries the reason it was once suspended for.
          suspendedReason: trimmedReason,
        },
      });

      await this.recordDealerAudit(tx, {
        action: auditActionFor(dealer.status, next),
        previousValues: { status: dealer.status },
        newValues: { status: next },
        dealer,
        ctx,
        reason: trimmedReason,
      });
    });

    return this.getOne(id);
  }

  /**
   * Reject an illegal state change with a message naming both states, so the
   * console can show the operator why (e.g. approving an already-active dealer).
   */
  private assertTransition(from: DealerStatus, to: DealerStatus): void {
    if (!ALLOWED_TRANSITIONS[from].includes(to)) {
      throw new BadRequestException(
        `Cannot change dealer status from ${from.toLowerCase()} to ${to.toLowerCase()}`,
      );
    }
  }

  /** Load the fields a mutation needs, or 404. Runs inside the caller's tx. */
  private async requireDealer(tx: Prisma.TransactionClient, id: string) {
    const dealer = await tx.catalogSeller.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        status: true,
        certified: true,
        lowestPrice: true,
      },
    });
    if (!dealer) throw new NotFoundException('Dealer not found');
    return dealer;
  }

  /** One audit entry for a dealer mutation, written in the caller's tx. */
  private async recordDealerAudit(
    tx: Prisma.TransactionClient,
    params: {
      action: AdminAuditAction;
      previousValues: Prisma.InputJsonValue;
      newValues: Prisma.InputJsonValue;
      dealer: { id: string; name: string };
      ctx: AdminAuditContext;
      reason?: string | null;
    },
  ): Promise<void> {
    await this.audit.record(
      {
        action: params.action,
        actor: params.ctx.actor,
        actorLabel: params.ctx.actorLabel,
        target: {
          entity: AdminAuditEntity.DEALER,
          id: params.dealer.id,
          name: params.dealer.name,
        },
        previousValues: params.previousValues,
        newValues: params.newValues,
        reason: params.reason ?? null,
        ip: params.ctx.ip,
        userAgent: params.ctx.userAgent,
      },
      tx,
    );
  }

  /**
   * Build the search OR-clause across dealer/store name, city and email — all
   * columns on the dealer row itself, so the whole filter runs in the database
   * with no join and no post-filtering. Text fields use case-insensitive
   * contains; phone matching is digit-only against the E.164 column, so a
   * substring match works whether or not the caller typed the '+' — the same
   * rules as the orders and users consoles.
   */
  private buildSearch(
    raw?: string,
  ): Prisma.CatalogSellerWhereInput[] | undefined {
    const term = raw?.trim();
    if (!term) return undefined;

    const or: Prisma.CatalogSellerWhereInput[] = [
      { name: { contains: term, mode: 'insensitive' } },
      { city: { contains: term, mode: 'insensitive' } },
      { email: { contains: term, mode: 'insensitive' } },
    ];

    const digits = term.replace(/\D/g, '');
    if (digits.length >= MIN_PHONE_SEARCH_DIGITS) {
      or.push({ phoneE164: { contains: digits } });
    }

    return or;
  }
}

/** Legal next states, keyed by the current one. */
const ALLOWED_TRANSITIONS: Record<DealerStatus, DealerStatus[]> = {
  [DealerStatus.PENDING]: [DealerStatus.ACTIVE],
  [DealerStatus.ACTIVE]: [DealerStatus.SUSPENDED],
  [DealerStatus.SUSPENDED]: [DealerStatus.ACTIVE],
};

/**
 * Audit verb for a transition, keyed by BOTH ends. The destination alone is not
 * enough: PENDING → ACTIVE is an approval while SUSPENDED → ACTIVE is a
 * reactivation, and the trail has to tell them apart. Only the legal
 * transitions appear here — assertTransition has already rejected the rest.
 */
function auditActionFor(
  from: DealerStatus,
  to: DealerStatus,
): AdminAuditAction {
  if (to === DealerStatus.SUSPENDED) return AdminAuditAction.DEALER_SUSPENDED;
  return from === DealerStatus.SUSPENDED
    ? AdminAuditAction.DEALER_REACTIVATED
    : AdminAuditAction.DEALER_APPROVED;
}
