import { Injectable } from '@nestjs/common';
import { AdminAuditAction, AdminAuditEntity, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AdminAuditEntry,
  AdminAuditService,
} from '../auth/admin-audit.service';
import { AdminAuditContext } from '../auth/admin-auth.service';
import { clampLimit } from '../../common/pagination.util';
import {
  ADMIN_INVENTORY_ROW_SELECT,
  presentInventoryRow,
} from './admin-inventory.presenter';
import {
  BatchUpdateInventoryDto,
  BatchUpdateInventoryItemDto,
} from './dto/batch-update-inventory.dto';
import {
  InventoryStockFilter,
  ListInventoryQueryDto,
} from './dto/list-inventory.query.dto';

const DEFAULT_ADMIN_INVENTORY_LIMIT = 20;
const MAX_ADMIN_INVENTORY_LIMIT = 100;

/** The columns one inventory edit writes. Only what the item names. */
function toPartUpdate(
  item: BatchUpdateInventoryItemDto,
): Prisma.CatalogPartUpdateInput {
  const data: Prisma.CatalogPartUpdateInput = {};
  if (item.purchasePrice !== undefined) {
    data.purchasePriceUzs =
      item.purchasePrice === null
        ? null
        : new Prisma.Decimal(item.purchasePrice);
  }
  if (item.retailPrice !== undefined) {
    data.priceUzs = new Prisma.Decimal(item.retailPrice);
  }
  if (item.cashbackPct !== undefined) {
    data.cashbackPct = new Prisma.Decimal(item.cashbackPct);
  }
  if (item.stock !== undefined) {
    data.stockQty = item.stock;
    // Keep the legacy boolean availability flag consistent with the count.
    data.inStock = item.stock > 0;
  }
  return data;
}

/** What an edit actually changes on a part, old and new, or null when nothing. */
function describeChange(
  part: {
    purchasePriceUzs: Prisma.Decimal | null;
    priceUzs: Prisma.Decimal;
    cashbackPct: Prisma.Decimal;
    stockQty: number;
  },
  item: BatchUpdateInventoryItemDto,
): { previous: Prisma.InputJsonObject; next: Prisma.InputJsonObject } | null {
  const fields: [string, number | null, number | null | undefined][] = [
    [
      'purchasePrice',
      part.purchasePriceUzs === null ? null : Number(part.purchasePriceUzs),
      item.purchasePrice,
    ],
    ['retailPrice', Number(part.priceUzs), item.retailPrice],
    ['cashbackPct', Number(part.cashbackPct), item.cashbackPct],
    ['stock', part.stockQty, item.stock],
  ];
  const changed = fields.filter(
    ([, current, next]) => next !== undefined && next !== current,
  );
  if (changed.length === 0) return null;
  return {
    previous: Object.fromEntries(changed.map(([k, current]) => [k, current])),
    next: Object.fromEntries(changed.map(([k, , next]) => [k, next ?? null])),
  };
}

/** The part as it stands after an edit, for describing the next edit of it. */
function applyEdit<
  T extends {
    purchasePriceUzs: Prisma.Decimal | null;
    priceUzs: Prisma.Decimal;
    cashbackPct: Prisma.Decimal;
    stockQty: number;
  },
>(part: T, item: BatchUpdateInventoryItemDto): T {
  return {
    ...part,
    ...(item.purchasePrice !== undefined
      ? {
          purchasePriceUzs:
            item.purchasePrice === null
              ? null
              : new Prisma.Decimal(item.purchasePrice),
        }
      : {}),
    ...(item.retailPrice !== undefined
      ? { priceUzs: new Prisma.Decimal(item.retailPrice) }
      : {}),
    ...(item.cashbackPct !== undefined
      ? { cashbackPct: new Prisma.Decimal(item.cashbackPct) }
      : {}),
    ...(item.stock !== undefined ? { stockQty: item.stock } : {}),
  };
}

/**
 * Admin/operator Smart-Inventory console. Backs /v1/admin/inventory over the
 * EXISTING buyer catalog part (CatalogPart): the on-hand quantity, purchase and
 * retail prices, cashback percentage, and the derived stock status.
 *
 * The list runs in two steps — a raw SQL id/count pass, then a Prisma read of
 * the page's rows — because two of its predicates cannot be expressed in
 * Prisma's `where`: the case-insensitive search must also match inside the
 * `oem_numbers` / `gm_numbers` string ARRAYS, and the low/in stock filters
 * compare `stock_qty` to the per-row `low_stock_threshold` COLUMN. Raw SQL keeps
 * both correct under pagination; the second Prisma read keeps the row shape and
 * relation selects type-safe.
 */
@Injectable()
export class AdminInventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  async list(query: ListInventoryQueryDto) {
    const page = query.page ?? 1;
    const limit = clampLimit(
      query.limit,
      DEFAULT_ADMIN_INVENTORY_LIMIT,
      MAX_ADMIN_INVENTORY_LIMIT,
    );
    const offset = (page - 1) * limit;

    const where = this.buildWhereSql(query);

    // Count + the page's ids in insertion order (stable, total order via id).
    const countRows = await this.prisma.$queryRaw<{ count: bigint }[]>(
      Prisma.sql`SELECT COUNT(*)::bigint AS count FROM "catalog_parts" ${where}`,
    );
    const totalItems = Number(countRows[0]?.count ?? 0n);

    const idRows = await this.prisma.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT "id" FROM "catalog_parts" ${where} ORDER BY "id" ASC LIMIT ${limit} OFFSET ${offset}`,
    );
    const pageIds = idRows.map((r) => r.id);

    // Second read: fetch the page's rows with typed relation selects, then
    // restore the raw-query order (findMany does not preserve `in` order).
    const rows = pageIds.length
      ? await this.prisma.catalogPart.findMany({
          where: { id: { in: pageIds } },
          select: ADMIN_INVENTORY_ROW_SELECT,
        })
      : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = pageIds
      .map((id) => byId.get(id))
      .filter((r): r is (typeof rows)[number] => r !== undefined);

    return {
      success: true,
      data: ordered.map(presentInventoryRow),
      meta: {
        page,
        limit,
        totalItems,
        totalPages: Math.ceil(totalItems / limit),
      },
    };
  }

  /**
   * Update many parts' inventory fields in ONE transaction: either every row
   * applies or none does. Only the fields present on an item are written, and each
   * part that really changed leaves an audit entry with its old and new values.
   * Returns the number of rows updated.
   *
   * The rows are locked first, in id order, so the "previous" values in the audit
   * are the ones this edit really replaced, and so another stock writer (a dealer
   * sync, the Driver's Village projection, a reservation) cannot interleave with
   * it: each waits for the other and then works on committed data. Only the
   * columns an item names are written; `reserved_qty` is never touched here.
   *
   * A batch may name one part more than once. Each edit is then described
   * against what the previous edit of that part left, not against the value the
   * batch started from.
   */
  async batchUpdate(dto: BatchUpdateInventoryDto, ctx: AdminAuditContext = {}) {
    const updated = await this.prisma.$transaction(
      async (tx) => {
        const ids = [...new Set(dto.items.map((item) => item.id))].sort();
        await tx.$queryRaw`
          SELECT id FROM catalog_parts
          WHERE id = ANY(${ids}::text[]) ORDER BY id FOR UPDATE`;
        const before = await tx.catalogPart.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            title: true,
            purchasePriceUzs: true,
            priceUzs: true,
            cashbackPct: true,
            stockQty: true,
          },
        });
        const byId = new Map(before.map((part) => [part.id, part]));

        let count = 0;
        const entries: AdminAuditEntry[] = [];
        for (const item of dto.items) {
          const data = toPartUpdate(item);
          const res = await tx.catalogPart.updateMany({
            where: { id: item.id },
            data,
          });
          count += res.count;

          const part = byId.get(item.id);
          const change = part ? describeChange(part, item) : null;
          if (part && change) {
            entries.push({
              action: AdminAuditAction.INVENTORY_UPDATED,
              actor: ctx.actor,
              actorLabel: ctx.actorLabel,
              target: {
                entity: AdminAuditEntity.CATALOG_PART,
                id: part.id,
                name: part.title.slice(0, 120),
              },
              previousValues: change.previous,
              newValues: change.next,
              ip: ctx.ip,
              userAgent: ctx.userAgent,
            });
          }
          if (part) byId.set(item.id, applyEdit(part, item));
        }
        await this.audit.recordMany(entries, tx);
        return count;
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
    return { success: true, data: { updated } };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /**
   * Build the WHERE fragment shared by the count and id queries. All predicates
   * are parameterised (Prisma.sql interpolation), so no client value is
   * concatenated into the SQL text.
   */
  private buildWhereSql(query: ListInventoryQueryDto): Prisma.Sql {
    const conds: Prisma.Sql[] = [];

    const term = query.search?.trim();
    if (term) {
      const like = `%${term}%`;
      // SKU (= id), name/title, OEM and GM numbers (array membership, matched
      // case-insensitively against each element), all OR'd together.
      conds.push(Prisma.sql`(
        "id" ILIKE ${like}
        OR "title" ILIKE ${like}
        OR EXISTS (SELECT 1 FROM unnest("oem_numbers") AS n WHERE n ILIKE ${like})
        OR EXISTS (SELECT 1 FROM unnest("gm_numbers") AS n WHERE n ILIKE ${like})
      )`);
    }

    if (query.categoryId) {
      conds.push(Prisma.sql`"category_id" = ${query.categoryId}`);
    }
    if (query.brandId) {
      conds.push(Prisma.sql`"brand_id" = ${query.brandId}`);
    }

    const stockCond = this.stockConditionSql(query.stock);
    if (stockCond) conds.push(stockCond);

    if (conds.length === 0) return Prisma.empty;
    return Prisma.sql`WHERE ${Prisma.join(conds, ' AND ')}`;
  }

  /** SQL predicate for the stock-status filter (compares to the per-row threshold). */
  private stockConditionSql(
    stock: InventoryStockFilter | undefined,
  ): Prisma.Sql | null {
    switch (stock) {
      case 'out_of_stock':
        return Prisma.sql`"stock_qty" <= 0`;
      case 'low_stock':
        return Prisma.sql`"stock_qty" > 0 AND "stock_qty" < "low_stock_threshold"`;
      case 'in_stock':
        return Prisma.sql`"stock_qty" >= "low_stock_threshold"`;
      default:
        return null;
    }
  }
}
