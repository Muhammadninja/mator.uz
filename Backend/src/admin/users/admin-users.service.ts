import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { clampLimit } from '../../common/pagination.util';
import {
  ADMIN_USER_ADDRESS_SELECT,
  ADMIN_USER_DETAIL_SELECT,
  ADMIN_USER_LIST_SELECT,
  AdminUserStats,
  SPEND_STATUSES,
  VEHICLE_INCLUDE,
  presentAdminUserAddress,
  presentAdminUserDetail,
  presentAdminUserRow,
  presentAdminVehicle,
} from './admin-users.presenter';
import {
  AdminUserSortField,
  ListAdminUsersQueryDto,
} from './dto/list-admin-users.query.dto';

const DEFAULT_ADMIN_USER_LIMIT = 20;
const MAX_ADMIN_USER_LIMIT = 100;
// Minimum digits before a search term is treated as a (partial) phone number —
// avoids a stray digit matching essentially every phone in the system. Same
// threshold as the admin orders console.
const MIN_PHONE_SEARCH_DIGITS = 4;

/** Whitelist mapping the accepted sort field onto the real Prisma column. */
const SORT_COLUMN: Record<
  AdminUserSortField,
  keyof Prisma.AppUserOrderByWithRelationInput
> = {
  createdAt: 'createdAt',
  name: 'displayName',
};

/**
 * Read-only admin/operator view over customer accounts. Backs the
 * /v1/admin/users console: the profile, addresses and garage behind the
 * `customer` summary already embedded in GET /v1/admin/orders/:id.
 *
 * Resource-oriented: the profile carries only the user and their order summary;
 * addresses and vehicles are separate endpoints, each with its own read.
 *
 * Scope: app users with the USER role only. Sellers and admin-side accounts are
 * not customers and are never returned here.
 */
@Injectable()
export class AdminUsersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListAdminUsersQueryDto) {
    const page = query.page ?? 1;
    const limit = clampLimit(
      query.limit,
      DEFAULT_ADMIN_USER_LIMIT,
      MAX_ADMIN_USER_LIMIT,
    );
    const sortField = query.sortBy ?? 'createdAt';
    const direction = query.order ?? 'desc';

    const where: Prisma.AppUserWhereInput = { role: Role.USER };
    const search = this.buildSearch(query.search);
    if (search) where.OR = search;

    const orderBy: Prisma.AppUserOrderByWithRelationInput = {
      [SORT_COLUMN[sortField]]: direction,
    };

    const [users, totalItems] = await this.prisma.$transaction([
      this.prisma.appUser.findMany({
        where,
        select: ADMIN_USER_LIST_SELECT,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.appUser.count({ where }),
    ]);

    // Spend/last-order for the whole page in grouped queries, not one per row.
    const spendByUser = await this.spendForUsers(users.map((u) => u.id));

    return {
      success: true,
      data: users.map((u) =>
        presentAdminUserRow(
          u,
          spendByUser.get(u.id) ?? { totalSpent: 0, lastOrderAt: null },
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

  /** Profile + order summary only. Addresses/vehicles are separate resources. */
  async getOne(id: string) {
    const user = await this.prisma.appUser.findFirst({
      where: { id, role: Role.USER },
      select: ADMIN_USER_DETAIL_SELECT,
    });
    if (!user) throw new NotFoundException('User not found');

    const stats = await this.statsForUser(id);
    return { success: true, data: presentAdminUserDetail(user, stats) };
  }

  /** Saved addresses of one user. 404s if the user is not a customer. */
  async listAddresses(id: string) {
    await this.assertCustomer(id);
    const addresses = await this.prisma.address.findMany({
      where: { userId: id },
      select: ADMIN_USER_ADDRESS_SELECT,
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    return { success: true, data: addresses.map(presentAdminUserAddress) };
  }

  /**
   * Garage of one user. Reuses the garage module's VEHICLE_INCLUDE — the same
   * query and relations the app's own garage list runs — and projects it in the
   * admin's camelCase vocabulary. Soft-deleted vehicles are excluded and the
   * ordering matches VehiclesService.list, so the operator sees the same
   * vehicles, in the same order, as the customer does in the app.
   */
  async listVehicles(id: string) {
    await this.assertCustomer(id);
    const vehicles = await this.prisma.vehicle.findMany({
      where: { userId: id, deletedAt: null },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }],
      include: VEHICLE_INCLUDE,
    });
    return { success: true, data: vehicles.map(presentAdminVehicle) };
  }

  /**
   * Guard for the sub-resources: a request for the addresses/vehicles of an id
   * that is not a customer 404s instead of returning an empty list, so a
   * non-existent (or seller/admin) id is never reported as "a customer with
   * nothing saved".
   */
  private async assertCustomer(id: string): Promise<void> {
    const exists = await this.prisma.appUser.findFirst({
      where: { id, role: Role.USER },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('User not found');
  }

  /**
   * Lifetime totals for one user. `totalOrders` counts every order the user
   * ever placed, while `totalSpent` sums only the statuses that represent
   * committed money (see SPEND_STATUSES) — the two intentionally disagree for a
   * user with cancelled or unpaid orders.
   */
  private async statsForUser(userId: string): Promise<AdminUserStats> {
    const [totalOrders, spend] = await Promise.all([
      this.prisma.order.count({ where: { userId } }),
      this.prisma.order.aggregate({
        where: { userId, status: { in: SPEND_STATUSES } },
        _sum: { totalUzs: true },
      }),
    ]);
    const last = await this.prisma.order.findFirst({
      where: { userId },
      select: { createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return {
      totalOrders,
      totalSpent: Number(spend._sum.totalUzs ?? 0),
      lastOrderAt: last?.createdAt ?? null,
    };
  }

  /**
   * Spend + most recent order date for a page of users, in one grouped read per
   * metric. Returns an empty map for an empty page so the caller can fall back
   * to zeroes without a special case.
   */
  private async spendForUsers(
    userIds: string[],
  ): Promise<Map<string, { totalSpent: number; lastOrderAt: Date | null }>> {
    const out = new Map<
      string,
      { totalSpent: number; lastOrderAt: Date | null }
    >();
    if (userIds.length === 0) return out;

    const [spendRows, lastRows] = await Promise.all([
      this.prisma.order.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds }, status: { in: SPEND_STATUSES } },
        _sum: { totalUzs: true },
      }),
      this.prisma.order.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds } },
        _max: { createdAt: true },
      }),
    ]);

    for (const row of spendRows) {
      out.set(row.userId, {
        totalSpent: Number(row._sum.totalUzs ?? 0),
        lastOrderAt: null,
      });
    }
    for (const row of lastRows) {
      const existing = out.get(row.userId);
      if (existing) {
        existing.lastOrderAt = row._max.createdAt ?? null;
      } else {
        out.set(row.userId, {
          totalSpent: 0,
          lastOrderAt: row._max.createdAt ?? null,
        });
      }
    }
    return out;
  }

  /**
   * Build the search OR-clause across name, phone and email. Phone matching is
   * digit-only against the E.164 column: since the stored value only differs by
   * a leading '+', a substring match works whether or not the caller typed it.
   * Text fields use case-insensitive contains — same rules as the orders search.
   */
  private buildSearch(raw?: string): Prisma.AppUserWhereInput[] | undefined {
    const term = raw?.trim();
    if (!term) return undefined;

    const or: Prisma.AppUserWhereInput[] = [
      { displayName: { contains: term, mode: 'insensitive' } },
      { firstName: { contains: term, mode: 'insensitive' } },
      { lastName: { contains: term, mode: 'insensitive' } },
      { email: { contains: term, mode: 'insensitive' } },
    ];

    const digits = term.replace(/\D/g, '');
    if (digits.length >= MIN_PHONE_SEARCH_DIGITS) {
      or.push({ phoneE164: { contains: digits } });
    }

    return or;
  }
}
