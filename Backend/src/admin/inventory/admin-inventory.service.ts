import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { clampLimit } from '../../common/pagination.util';
import {
  ADMIN_INVENTORY_ROW_SELECT,
  presentInventoryRow,
} from './admin-inventory.presenter';
import { BatchUpdateInventoryDto } from './dto/batch-update-inventory.dto';
import {
  InventoryStockFilter,
  ListInventoryQueryDto,
} from './dto/list-inventory.query.dto';

const DEFAULT_ADMIN_INVENTORY_LIMIT = 20;
const MAX_ADMIN_INVENTORY_LIMIT = 100;

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
  constructor(private readonly prisma: PrismaService) {}

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
   * applies or none does. Only the fields present on an item are written.
   * Returns the number of rows updated.
   */
  async batchUpdate(dto: BatchUpdateInventoryDto) {
    const updates = dto.items.map((item) => {
      const data: Prisma.CatalogPartUpdateInput = {};
      if (item.purchasePrice !== undefined) {
        data.purchasePriceUzs = new Prisma.Decimal(item.purchasePrice);
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
      return this.prisma.catalogPart.updateMany({
        where: { id: item.id },
        data,
      });
    });

    const results = await this.prisma.$transaction(updates);
    const updated = results.reduce((sum, r) => sum + r.count, 0);
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
