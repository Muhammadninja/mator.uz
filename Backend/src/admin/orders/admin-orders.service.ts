import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeliveryMethod, OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  findPickupPoints,
  isGoodsLine,
} from '../../shipping/pickup-points.service';
import { clampLimit } from '../../common/pagination.util';
import { ORDER_STATUSES } from '../../orders/dto/list-orders.query.dto';
import {
  OfflineOrderPolicy,
  isOverOfflineSla,
  isPastOperatorWarning,
  readOfflineOrderPolicy,
  waitingOfflineOrders,
} from '../../orders/offline-order.policy';
import {
  ADMIN_ORDER_DETAIL_SELECT,
  ADMIN_ORDER_LIST_SELECT,
  REFUND_DUE_WHERE,
  presentAdminOrderDetail,
  presentAdminOrderRow,
} from './admin-orders.presenter';
import {
  AdminOrderSortField,
  ListAdminOrdersQueryDto,
} from './dto/list-admin-orders.query.dto';

const DEFAULT_ADMIN_ORDER_LIMIT = 20;
const MAX_ADMIN_ORDER_LIMIT = 100;
// Minimum digits before a search term is treated as a (partial) phone number —
// avoids a stray digit matching essentially every phone in the system.
const MIN_PHONE_SEARCH_DIGITS = 4;
const DEFAULT_BOARD_PER_STATUS = 25;
/** Money actually committed: the same statuses a customer's lifetime spend sums. */
const REVENUE_STATUSES: OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
];

/** Whitelist mapping the accepted sort field onto the real Prisma column. */
const SORT_COLUMN: Record<
  AdminOrderSortField,
  keyof Prisma.OrderOrderByWithRelationInput
> = {
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  totalAmount: 'totalUzs',
  status: 'status',
};

/**
 * Read-only admin/operator view over EVERY order in the system (never scoped to
 * the caller). Backs GET /v1/admin/orders and GET /v1/admin/orders/:id.
 */
@Injectable()
export class AdminOrdersService {
  private readonly offlinePolicy: OfflineOrderPolicy;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.offlinePolicy = readOfflineOrderPolicy((key) =>
      config.get<string>(key),
    );
  }

  async list(query: ListAdminOrdersQueryDto) {
    const page = query.page ?? 1;
    const limit = clampLimit(
      query.limit,
      DEFAULT_ADMIN_ORDER_LIMIT,
      MAX_ADMIN_ORDER_LIMIT,
    );
    const sortField = query.sortBy ?? 'createdAt';
    const direction = query.order ?? 'desc';

    const where: Prisma.OrderWhereInput = {};
    const statuses = this.parseStatuses(query.status);
    if (statuses) where.status = { in: statuses };
    const search = this.buildSearch(query.search);
    if (search) where.OR = search;
    if (query.customerId) where.userId = query.customerId;
    // Under AND rather than spread: each carries its own `status`, which must
    // combine with the filter above, not overwrite it.
    const now = new Date();
    const narrowed = [
      ...(query.slaOverdue === 'true'
        ? [waitingOfflineOrders(now, this.offlinePolicy.slaHours)]
        : []),
      ...(query.operatorWarning === 'true'
        ? [this.pastOperatorWarning(now)]
        : []),
      ...(query.refundDue === 'true' ? [REFUND_DUE_WHERE] : []),
    ];
    if (narrowed.length > 0) where.AND = narrowed;

    // The secondary `id` key makes the order total, as on the dealers list: rows
    // sharing a sort value (every order in one status) could otherwise come back
    // in a different order per page, so one repeats and another is never shown.
    const orderBy: Prisma.OrderOrderByWithRelationInput[] = [
      { [SORT_COLUMN[sortField]]: direction },
      { id: 'asc' },
    ];

    const [orders, totalItems] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        select: ADMIN_ORDER_LIST_SELECT,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      success: true,
      data: orders.map((o) =>
        presentAdminOrderRow(
          o,
          isOverOfflineSla(o, now, this.offlinePolicy),
          isPastOperatorWarning(o, now, this.offlinePolicy),
        ),
      ),
      meta: {
        page,
        limit,
        totalItems,
        totalPages: Math.ceil(totalItems / limit),
      },
    };
  }

  async getOne(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      select: ADMIN_ORDER_DETAIL_SELECT,
    });
    if (!order) throw new NotFoundException('Order not found');
    const sellerIds = [
      ...new Set(order.items.flatMap((it) => it.sellerId ?? [])),
    ];
    const sellers = sellerIds.length
      ? await this.prisma.catalogSeller.findMany({
          where: { id: { in: sellerIds } },
          select: { id: true, name: true },
        })
      : [];
    // Only an order the buyer collects has pickup points. Each line goes to the dealer the
    // order recorded for it when placed, never to one looked up again from the part.
    const pickupPoints =
      order.deliveryMethod === DeliveryMethod.PICKUP
        ? await findPickupPoints(
            this.prisma,
            order.items.filter(isGoodsLine).map((it) => ({
              storefrontId: it.sellerId,
              offerSellerTgId: it.offerSellerTgId,
              item: {
                id: it.id,
                productId: it.partId,
                title: it.title,
                quantity: it.quantity,
              },
            })),
          )
        : null;
    return {
      success: true,
      data: presentAdminOrderDetail(
        order,
        isOverOfflineSla(order, new Date(), this.offlinePolicy),
        isPastOperatorWarning(order, new Date(), this.offlinePolicy),
        new Map(sellers.map((seller) => [seller.id, seller.name])),
        pickupPoints,
      ),
    };
  }

  /**
   * Totals for the dashboard and the queue header, over every order. Grouped in the
   * database: a figure summed from one fetched page would quietly stop being true
   * once there is more than a page of orders.
   */
  async summary() {
    const now = new Date();
    const [counts, slaOverdue, operatorWarnings, refundsDue] =
      await Promise.all([
        this.statusTotals(),
        this.prisma.order.count({
          where: waitingOfflineOrders(now, this.offlinePolicy.slaHours),
        }),
        this.prisma.order.count({ where: this.pastOperatorWarning(now) }),
        this.prisma.order.count({ where: REFUND_DUE_WHERE }),
      ]);
    return {
      success: true,
      data: {
        ...counts,
        slaOverdue,
        operatorWarnings,
        refundsDue,
        slaHours: this.offlinePolicy.slaHours,
        operatorWarningHours: this.offlinePolicy.operatorWarningHours,
      },
    };
  }

  /**
   * The order timeline in one request: the newest orders of each status plus the
   * true total behind each column. One read per status, since a page across all
   * statuses would fill up with whichever is most common.
   */
  async board(perStatus: number = DEFAULT_BOARD_PER_STATUS) {
    const now = new Date();
    const [totals, columns] = await Promise.all([
      this.statusTotals(),
      Promise.all(
        ORDER_STATUSES.map(async (status) => {
          const rows = await this.prisma.order.findMany({
            where: { status: status.toUpperCase() as OrderStatus },
            select: ADMIN_ORDER_LIST_SELECT,
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            take: perStatus,
          });
          return [
            status,
            rows.map((o) =>
              presentAdminOrderRow(
                o,
                isOverOfflineSla(o, now, this.offlinePolicy),
                isPastOperatorWarning(o, now, this.offlinePolicy),
              ),
            ),
          ] as const;
        }),
      ),
    ]);
    return {
      success: true,
      data: { ...totals, columns: Object.fromEntries(columns) },
    };
  }

  /** Matches nothing when the warning is switched off. */
  private pastOperatorWarning(now: Date): Prisma.OrderWhereInput {
    const hours = this.offlinePolicy.operatorWarningHours;
    return hours > 0 ? waitingOfflineOrders(now, hours) : { id: { in: [] } };
  }

  private async statusTotals() {
    const [rows, feesReturned] = await Promise.all([
      this.prisma.order.groupBy({
        by: ['status'],
        _count: { _all: true },
        _sum: { totalUzs: true, serviceFeeUzs: true },
      }),
      // The share of the fee refunds gave back on orders still counted below. An order that
      // left those statuses took its whole fee out of the figure with it.
      this.prisma.financialRefund.aggregate({
        where: {
          voidedAt: null,
          order: { status: { in: REVENUE_STATUSES } },
        },
        _sum: { serviceFeeUzs: true },
      }),
    ]);
    const counts = Object.fromEntries(
      ORDER_STATUSES.map((status) => [status, 0]),
    ) as Record<(typeof ORDER_STATUSES)[number], number>;
    let totalOrders = 0;
    let revenueUzs = 0;
    let serviceFeeRevenueUzs = -Number(feesReturned._sum.serviceFeeUzs ?? 0);
    for (const row of rows) {
      const key = row.status.toLowerCase() as keyof typeof counts;
      counts[key] = row._count._all;
      totalOrders += row._count._all;
      if (REVENUE_STATUSES.includes(row.status)) {
        revenueUzs += Number(row._sum.totalUzs ?? 0);
        serviceFeeRevenueUzs += Number(row._sum.serviceFeeUzs ?? 0);
      }
    }
    return { counts, totalOrders, revenueUzs, serviceFeeRevenueUzs };
  }

  /**
   * Parse the comma-separated `status` filter. `all` (or an empty value) means
   * no filter; every other token must be a real OrderStatus or the request is
   * rejected with 400 — invalid client input never reaches Prisma.
   */
  private parseStatuses(raw?: string): OrderStatus[] | undefined {
    if (!raw) return undefined;
    const tokens = raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (tokens.length === 0 || tokens.includes('all')) return undefined;

    const statuses = tokens.map((token) => {
      if (!(ORDER_STATUSES as readonly string[]).includes(token)) {
        throw new BadRequestException(`Unknown order status: ${token}`);
      }
      return token.toUpperCase() as OrderStatus;
    });
    return statuses.length ? statuses : undefined;
  }

  /**
   * Build the search OR-clause across order id, customer name and phone. Phone
   * matching is digit-only against the E.164 column: since the stored value only
   * differs by a leading '+', a substring match works whether or not the caller
   * typed the '+'. Text fields use case-insensitive contains.
   */
  private buildSearch(raw?: string): Prisma.OrderWhereInput[] | undefined {
    const term = raw?.trim();
    if (!term) return undefined;

    const or: Prisma.OrderWhereInput[] = [
      { id: { contains: term, mode: 'insensitive' } },
      { user: { displayName: { contains: term, mode: 'insensitive' } } },
      { user: { firstName: { contains: term, mode: 'insensitive' } } },
      { user: { lastName: { contains: term, mode: 'insensitive' } } },
    ];

    const digits = term.replace(/\D/g, '');
    if (digits.length >= MIN_PHONE_SEARCH_DIGITS) {
      or.push({ user: { phoneE164: { contains: digits } } });
      or.push({ contactPhoneE164: { contains: digits } });
    }

    return or;
  }
}
