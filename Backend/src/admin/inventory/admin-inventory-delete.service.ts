import { Injectable } from '@nestjs/common';
import {
  AdminAuditAction,
  AdminAuditEntity,
  Prisma,
  SaleScopeType,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AdminAuditEntry,
  AdminAuditService,
} from '../auth/admin-audit.service';
import { AdminAuditContext } from '../auth/admin-auth.service';
import { BatchDeleteInventoryDto } from './dto/batch-delete-inventory.dto';

/** A part projected from a supply-side Stock row: see CatalogProjectionService.catalogPartId. */
const STOCK_PART_ID = /^part_stock_(\d{1,10})$/;

/** The Stock row a catalog part was projected from, or null for a part with none. */
export function stockIdOf(partId: string): number | null {
  const match = STOCK_PART_ID.exec(partId);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id <= 2_147_483_647 ? id : null;
}

/**
 * Deletes parts for good from the Smart-Inventory console.
 *
 * A catalog part is a projection. One projected from a Stock row would come back the
 * next time that row is projected, so the Stock row goes with it, and its Product
 * when no other seller still lists it (images and fitment rows cascade). On the buyer
 * side the part's favourites, fitment and compatibility rows cascade; cart lines and
 * per-product sale targets hold its id as a plain column and are removed here.
 *
 * Order lines, reservations and shortage records are kept: they hold a copy of what
 * was sold and outlive the part by design. A part with units still reserved for an
 * open order is skipped, not deleted, so that order can still be reconciled against
 * it. Each deleted part leaves an audit entry with what it was.
 *
 * A 1C import that still lists the position creates it again: the import, not this
 * console, owns what a dealer's file contains.
 */
@Injectable()
export class AdminInventoryDeleteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  async batchDelete(dto: BatchDeleteInventoryDto, ctx: AdminAuditContext = {}) {
    const result = await this.prisma.$transaction(
      async (tx) => {
        const ids = [...new Set(dto.ids)].sort();
        // Lock first, in id order, so a reservation, a dealer sync or a projection
        // waits for this delete or finishes before it, never interleaves.
        await tx.$queryRaw`
          SELECT id FROM catalog_parts
          WHERE id = ANY(${ids}::text[]) ORDER BY id FOR UPDATE`;
        const parts = await tx.catalogPart.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            title: true,
            sellerId: true,
            categoryId: true,
            priceUzs: true,
            purchasePriceUzs: true,
            stockQty: true,
            reservedQty: true,
            oemNumbers: true,
            gmNumbers: true,
            images: true,
          },
        });

        const reserved = parts
          .filter((p) => p.reservedQty > 0)
          .map((p) => p.id);
        const doomed = parts.filter((p) => p.reservedQty <= 0);
        const doomedIds = doomed.map((p) => p.id);
        const found = new Set(parts.map((p) => p.id));
        const missing = ids.filter((id) => !found.has(id));
        if (doomedIds.length === 0) {
          return { deleted: 0, reserved, missing };
        }

        // Supply side: the Stock rows, then any Product left with no Stock.
        const stockIds = doomedIds
          .map(stockIdOf)
          .filter((id): id is number => id !== null);
        const stocks = stockIds.length
          ? await tx.stock.findMany({
              where: { id: { in: stockIds } },
              select: {
                id: true,
                productId: true,
                sourceSystem: true,
                sourceCode: true,
              },
            })
          : [];
        const stockById = new Map(stocks.map((s) => [s.id, s]));
        const removedProducts = new Set<number>();
        if (stocks.length) {
          await tx.stock.deleteMany({
            where: { id: { in: stocks.map((s) => s.id) } },
          });
          const productIds = [...new Set(stocks.map((s) => s.productId))];
          const stillListed = await tx.stock.findMany({
            where: { productId: { in: productIds } },
            select: { productId: true },
          });
          const listed = new Set(stillListed.map((s) => s.productId));
          const orphans = productIds.filter((id) => !listed.has(id));
          if (orphans.length) {
            await tx.product.deleteMany({ where: { id: { in: orphans } } });
            for (const id of orphans) removedProducts.add(id);
          }
        }

        // Buyer side: rows that name the part by a plain id, then the part itself.
        await tx.cartItem.deleteMany({ where: { partId: { in: doomedIds } } });
        await tx.saleTarget.deleteMany({
          where: {
            targetType: SaleScopeType.PRODUCTS,
            targetId: { in: doomedIds },
          },
        });
        const { count } = await tx.catalogPart.deleteMany({
          where: { id: { in: doomedIds } },
        });

        const entries: AdminAuditEntry[] = doomed.map((part) => {
          const stockId = stockIdOf(part.id);
          const stock = stockId === null ? undefined : stockById.get(stockId);
          return {
            action: AdminAuditAction.CATALOG_PART_DELETED,
            actor: ctx.actor,
            actorLabel: ctx.actorLabel,
            target: {
              entity: AdminAuditEntity.CATALOG_PART,
              id: part.id,
              name: part.title.slice(0, 120),
            },
            previousValues: {
              title: part.title,
              sellerId: part.sellerId,
              categoryId: part.categoryId,
              retailPrice: Number(part.priceUzs),
              purchasePrice:
                part.purchasePriceUzs === null
                  ? null
                  : Number(part.purchasePriceUzs),
              stock: part.stockQty,
              oemNumbers: part.oemNumbers,
              gmNumbers: part.gmNumbers,
              images: part.images,
              stockId: stock?.id ?? null,
              productId: stock?.productId ?? null,
              productDeleted: stock
                ? removedProducts.has(stock.productId)
                : false,
              sourceSystem: stock?.sourceSystem ?? null,
              sourceCode: stock?.sourceCode ?? null,
            } satisfies Prisma.InputJsonObject,
            newValues: null,
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          };
        });
        await this.audit.recordMany(entries, tx);
        return { deleted: count, reserved, missing };
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
    return { success: true, data: result };
  }
}
