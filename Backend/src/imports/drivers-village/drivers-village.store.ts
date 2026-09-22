/**
 * Persistence boundary of the Driver's Village importer.
 *
 * The planner and service talk to this narrow interface only, so the whole
 * import can be exercised against an in-memory store in tests, and a dry run
 * provably never reaches a write method.
 *
 * ── What a write touches (and what it never touches) ──
 * Writes: Product (import-owned columns only), Stock (price, quantity, unit,
 * source identity), part_models, part_makes, and brands / car_models rows for
 * vehicles that do not exist yet — the same reference upserts the Telegram
 * pipeline performs through persistVehicleLinks.
 * Never: product photos (ProductImage rows), products.image_url, description, ratings, kind,
 * package form, sellers, catalog_sellers, part_categories. Photos added to an
 * imported product (the future album + caption flow) survive every re-import.
 */
import {
  PrismaClient,
  Prisma,
  ProductKind,
  PartNumberType,
} from '@prisma/client';
import { persistVehicleLinks } from '../../telegram/vehicle-links';
import { CatalogProjectionService } from '../../catalog/projection/catalog-projection.service';
import {
  DRIVERS_VILLAGE_SOURCE_SYSTEM,
  IMPORT_LIMITS,
} from './drivers-village.constants';
import type {
  CategoryNode,
  ExistingPosition,
  PositionWrite,
} from './drivers-village.types';

export interface CatalogSellerRef {
  id: string;
  name: string;
}

export interface LinkedSellerRef {
  id: number;
  status: string;
  /** TELEGRAM | BUSINESS (SellerType). */
  sellerType: string;
}

export interface WrittenPosition {
  code1c: string;
  stockId: number;
  productId: number;
  created: boolean;
}

/** The migration that adds every column the importer reads and writes. */
export const REQUIRED_MIGRATION = '20260923000000_drivers_village_1c_import';

export interface DriversVillageStore {
  /** False when the database predates REQUIRED_MIGRATION. Read-only check. */
  schemaReady(): Promise<boolean>;
  findCatalogSeller(id: string): Promise<CatalogSellerRef | null>;
  /** The supply-side seller explicitly linked to the catalog dealer, if any. */
  findLinkedSeller(catalogSellerId: string): Promise<LinkedSellerRef | null>;
  loadCategories(): Promise<CategoryNode[]>;
  /** Existing imported positions of this seller, keyed by code_1c. */
  loadPositions(
    sellerId: number,
    codes: string[],
  ): Promise<Map<string, ExistingPosition>>;
  /** Every code_1c this seller has in the database (to report file gaps). */
  loadAllSourceCodes(sellerId: number): Promise<string[]>;
  /** Write one batch atomically: all positions or none. */
  applyBatch(
    sellerId: number,
    writes: PositionWrite[],
  ): Promise<WrittenPosition[]>;
}

/** Derive the legacy label + flags from the labeled number lists. */
export function numberLabels(
  gm: string[],
  oem: string[],
): {
  partNumberType: PartNumberType;
  isGm: boolean;
  isOem: boolean;
} {
  const partNumberType =
    gm.length > 0 && oem.length === 0
      ? PartNumberType.GM
      : oem.length > 0 && gm.length === 0
        ? PartNumberType.OEM
        : PartNumberType.UNKNOWN;
  return { partNumberType, isGm: gm.length > 0, isOem: oem.length > 0 };
}

const LOOKUP_CHUNK = 1000;

export class PrismaDriversVillageStore implements DriversVillageStore {
  constructor(private readonly prisma: PrismaClient) {}

  async schemaReady(): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND ((table_name = 'stocks' AND column_name IN ('source_system', 'source_code', 'unit'))
          OR (table_name = 'sellers' AND column_name = 'catalog_seller_id')
          OR (table_name = 'products' AND column_name IN ('gm_numbers', 'oem_numbers')))`;
    return Number(rows[0]?.n ?? 0) === 6;
  }

  findCatalogSeller(id: string): Promise<CatalogSellerRef | null> {
    return this.prisma.catalogSeller.findUnique({
      where: { id },
      select: { id: true, name: true },
    });
  }

  findLinkedSeller(catalogSellerId: string): Promise<LinkedSellerRef | null> {
    return this.prisma.seller.findUnique({
      where: { catalogSellerId },
      select: { id: true, status: true, sellerType: true },
    });
  }

  loadCategories(): Promise<CategoryNode[]> {
    return this.prisma.partCategory.findMany({
      select: { id: true, parentId: true, level: true, isActive: true },
    });
  }

  async loadPositions(
    sellerId: number,
    codes: string[],
  ): Promise<Map<string, ExistingPosition>> {
    const out = new Map<string, ExistingPosition>();
    for (let i = 0; i < codes.length; i += LOOKUP_CHUNK) {
      const stocks = await this.prisma.stock.findMany({
        where: {
          sellerId,
          sourceSystem: DRIVERS_VILLAGE_SOURCE_SYSTEM,
          sourceCode: { in: codes.slice(i, i + LOOKUP_CHUNK) },
        },
        select: {
          id: true,
          sourceCode: true,
          priceUzs: true,
          quantity: true,
          unit: true,
          productId: true,
          product: {
            select: {
              title: true,
              gmNumbers: true,
              oemNumbers: true,
              categoryId: true,
              vehicleCategoryId: true,
              isUniversal: true,
              partModels: {
                select: {
                  model: {
                    select: { name: true, brand: { select: { name: true } } },
                  },
                },
              },
              partMakes: { select: { brand: { select: { name: true } } } },
              _count: { select: { images: true } },
            },
          },
        },
      });
      const projected = new Set(
        (
          await this.prisma.catalogPart.findMany({
            where: {
              id: {
                in: stocks.map((s) =>
                  CatalogProjectionService.catalogPartId(s.id),
                ),
              },
            },
            select: { id: true },
          })
        ).map((p) => p.id),
      );
      for (const s of stocks) {
        if (!s.sourceCode) continue;
        out.set(s.sourceCode, {
          stockId: s.id,
          productId: s.productId,
          sourceCode: s.sourceCode,
          priceUzs: s.priceUzs.toFixed(2),
          quantity: s.quantity,
          unit: s.unit,
          title: s.product.title,
          gmNumbers: s.product.gmNumbers,
          oemNumbers: s.product.oemNumbers,
          categoryId: s.product.categoryId,
          vehicleCategoryId: s.product.vehicleCategoryId,
          isUniversal: s.product.isUniversal,
          models: s.product.partModels
            .map((pm) => `${pm.model.brand.name}|${pm.model.name}`)
            .sort(),
          makes: s.product.partMakes.map((pm) => pm.brand.name).sort(),
          imageCount: s.product._count.images,
          hasCatalogPart: projected.has(
            CatalogProjectionService.catalogPartId(s.id),
          ),
        });
      }
    }
    return out;
  }

  async loadAllSourceCodes(sellerId: number): Promise<string[]> {
    const rows = await this.prisma.stock.findMany({
      where: { sellerId, sourceSystem: DRIVERS_VILLAGE_SOURCE_SYSTEM },
      select: { sourceCode: true },
    });
    return rows.map((r) => r.sourceCode).filter((c): c is string => !!c);
  }

  applyBatch(
    sellerId: number,
    writes: PositionWrite[],
  ): Promise<WrittenPosition[]> {
    return this.prisma.$transaction(
      async (tx) => {
        const written: WrittenPosition[] = [];
        for (const w of writes)
          written.push(await writePosition(tx, sellerId, w));
        return written;
      },
      {
        timeout: IMPORT_LIMITS.batchTimeoutMs,
        maxWait: IMPORT_LIMITS.batchMaxWaitMs,
      },
    );
  }
}

/**
 * Upsert one position inside the batch transaction. The Stock's
 * (seller, source system, code_1c) key decides create vs update, so a
 * re-import converges on the same Stock and Product rows.
 */
export async function writePosition(
  tx: Prisma.TransactionClient,
  sellerId: number,
  w: PositionWrite,
): Promise<WrittenPosition> {
  const key = {
    sellerId,
    sourceSystem: DRIVERS_VILLAGE_SOURCE_SYSTEM,
    sourceCode: w.code1c,
  };
  const existing = await tx.stock.findUnique({
    where: { sellerId_sourceSystem_sourceCode: key },
    select: { id: true, productId: true },
  });

  // Import-owned product columns ONLY. Photos, image_url, description, rating,
  // kind and package form are never listed here, so they are never changed.
  const productData = {
    title: w.product.title,
    gmNumbers: w.product.gmNumbers,
    oemNumbers: w.product.oemNumbers,
    ...numberLabels(w.product.gmNumbers, w.product.oemNumbers),
    isUniversal: w.product.isUniversal,
    categoryId: w.product.categoryId,
    vehicleCategoryId: w.product.vehicleCategoryId,
    mainCategory: w.product.mainCategory,
    vehicleCategory: w.product.vehicleCategory,
  };

  const productId = existing
    ? (
        await tx.product.update({
          where: { id: existing.productId },
          data: productData,
          select: { id: true },
        })
      ).id
    : // gmNumber stays NULL: it is the Telegram upsert key, so an imported
      // product can never be matched (and overwritten) by a wizard listing.
      (
        await tx.product.create({
          data: { ...productData, kind: ProductKind.SPARE_PART },
          select: { id: true },
        })
      ).id;

  // Specific models: the shared reconcile-then-recreate writer the Telegram
  // pipeline uses (clears stale links, so no duplicate fitment).
  await persistVehicleLinks(tx, productId, {
    isUniversal: w.product.isUniversal,
    vehicles: w.models.map((v) => ({ brand: v.make, model: v.model })),
  });

  // Make-wide link, reconciled the same way.
  await tx.partMake.deleteMany({ where: { partId: productId } });
  if (w.make) {
    const brand = await tx.brand.upsert({
      where: { name: w.make },
      update: {},
      create: { name: w.make },
      select: { id: true },
    });
    await tx.partMake.create({
      data: { partId: productId, brandId: brand.id },
    });
  }

  const stockData = {
    priceUzs: new Prisma.Decimal(w.priceUzs),
    quantity: w.quantity,
    unit: w.unit,
  };
  const stock = existing
    ? await tx.stock.update({
        where: { id: existing.id },
        data: stockData,
        select: { id: true },
      })
    : await tx.stock.create({
        data: { ...key, productId, ...stockData },
        select: { id: true },
      });

  return { code1c: w.code1c, stockId: stock.id, productId, created: !existing };
}
