import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { clampLimit } from '../../common/pagination.util';
import { ORDER_STATUSES } from '../../orders/dto/list-orders.query.dto';
import {
  ADMIN_ORDER_DETAIL_SELECT,
  ADMIN_ORDER_LIST_SELECT,
  presentAdminOrderDetail,
  presentAdminOrderRow,
} from './admin-orders.presenter';
import { AdminOrderSortField, ListAdminOrdersQueryDto } from './dto/list-admin-orders.query.dto';

const DEFAULT_ADMIN_ORDER_LIMIT = 20;
const MAX_ADMIN_ORDER_LIMIT = 100;
// Minimum digits before a search term is treated as a (partial) phone number —
// avoids a stray digit matching essentially every phone in the system.
const MIN_PHONE_SEARCH_DIGITS = 4;

/** Whitelist mapping the accepted sort field onto the real Prisma column. */
const SORT_COLUMN: Record<AdminOrderSortField, keyof Prisma.OrderOrderByWithRelationInput> = {
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
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListAdminOrdersQueryDto) {
    const page = query.page ?? 1;
    const limit = clampLimit(query.limit, DEFAULT_ADMIN_ORDER_LIMIT, MAX_ADMIN_ORDER_LIMIT);
    const sortField = query.sortBy ?? 'createdAt';
    const direction = query.order ?? 'desc';

    const where: Prisma.OrderWhereInput = {};
    const statuses = this.parseStatuses(query.status);
    if (statuses) where.status = { in: statuses };
    const search = this.buildSearch(query.search);
    if (search) where.OR = search;

    const orderBy: Prisma.OrderOrderByWithRelationInput = { [SORT_COLUMN[sortField]]: direction };

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
      data: orders.map(presentAdminOrderRow),
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
    return { success: true, data: presentAdminOrderDetail(order) };
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
