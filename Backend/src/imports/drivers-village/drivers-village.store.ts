/**
 * Persistence boundary of the Driver's Village importer.
 *
 * The planner and service talk to this narrow interface only, so the whole
 * import can be exercised against an in-memory store in tests, and a dry run
 * provably never reaches a write method.
 *
 * ── What a write touches (and what it never touches) ──
 * A position is found by its exact (seller, DRIVERS_VILLAGE_1C, code_1c) only.
 * • Initial creation of a NEW position (createPosition): Product (the
 *   importOwnedProductData allowlist below), Stock (price, quantity, unit,
 *   source identity), part_models / part_makes from the file, and brands /
 *   car_models rows for vehicles that do not exist yet.
 * • Synchronization of a STORED position (syncStock): stocks.price_uzs and —
 *   only when the file states it — stocks.quantity. Nothing else: not the
 *   product, its name, numbers or unit, not its vehicle links.
 * Never, in either case: the category (products.category_id /
 * vehicle_category_id and the main_category / vehicle_category mirrors),
 * product photos (ProductImage rows), products.image_url, description,
 * ratings, kind, package form, fitment_bindings, part_compatibilities,
 * sellers, catalog_sellers, part_categories. Classification is written only by
 * the separate classification import (drivers-village-classification.store).
 */
import {
  PrismaClient,
  Prisma,
  ProductKind,
  PartNumberType,
} from '@prisma/client';
import { addVehicleLinks } from '../../telegram/vehicle-links';
import { CatalogProjectionService } from '../../catalog/projection/catalog-projection.service';
import {
  DRIVERS_VILLAGE_SOURCE_SYSTEM,
  IMPORT_LIMITS,
} from './drivers-village.constants';
import type {
  BatchWrite,
  ExistingPosition,
  PositionWrite,
  StockSync,
  VehicleReference,
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

/** The migrations that add every column the importer reads and writes. */
export const REQUIRED_MIGRATIONS = [
  '20260923000000_drivers_village_1c_import',
  '20261009000000_drivers_village_source_part_number',
] as const;

export interface DriversVillageStore {
  /** False when the database predates REQUIRED_MIGRATIONS. Read-only check. */
  schemaReady(): Promise<boolean>;
  findCatalogSeller(id: string): Promise<CatalogSellerRef | null>;
  /** The supply-side seller explicitly linked to the catalog dealer, if any. */
  findLinkedSeller(catalogSellerId: string): Promise<LinkedSellerRef | null>;
  /** Buyer vehicle reference names, to check fitment against. Read-only. */
  loadVehicleReference(): Promise<VehicleReference>;
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
    writes: BatchWrite[],
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
          OR (table_name = 'products' AND column_name IN ('gm_numbers', 'oem_numbers', 'source_part_number')))`;
    return Number(rows[0]?.n ?? 0) === 7;
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

  async loadVehicleReference(): Promise<VehicleReference> {
    const [makes, models] = await Promise.all([
      this.prisma.vehicleMake.findMany({ select: { id: true, name: true } }),
      this.prisma.vehicleModelRef.findMany({
        select: { makeId: true, name: true },
      }),
    ]);
    const makeName = new Map(makes.map((m) => [m.id, m.name]));
    return {
      makes: makes.map((m) => m.name),
      models: models
        .filter((m) => makeName.has(m.makeId))
        .map((m) => `${makeName.get(m.makeId)}|${m.name}`),
    };
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
              sourcePartNumber: true,
              oemNumbers: true,
              categoryId: true,
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
      // The projected catalog part, where an operator classifies a position.
      const projected = new Map(
        (
          await this.prisma.catalogPart.findMany({
            where: {
              id: {
                in: stocks.map((s) =>
                  CatalogProjectionService.catalogPartId(s.id),
                ),
              },
            },
            select: { id: true, categoryId: true },
          })
        ).map((p) => [p.id, p.categoryId]),
      );
      for (const s of stocks) {
        if (!s.sourceCode) continue;
        const partId = CatalogProjectionService.catalogPartId(s.id);
        out.set(s.sourceCode, {
          stockId: s.id,
          productId: s.productId,
          sourceCode: s.sourceCode,
          priceUzs: s.priceUzs.toFixed(2),
          quantity: s.quantity,
          unit: s.unit,
          title: s.product.title,
          gmNumbers: s.product.gmNumbers,
          sourcePartNumber: s.product.sourcePartNumber,
          oemNumbers: s.product.oemNumbers,
          categoryId: projected.get(partId) ?? s.product.categoryId,
          isUniversal: s.product.isUniversal,
          models: s.product.partModels
            .map((pm) => `${pm.model.brand.name}|${pm.model.name}`)
            .sort(),
          makes: s.product.partMakes.map((pm) => pm.brand.name).sort(),
          imageCount: s.product._count.images,
          hasCatalogPart: projected.has(partId),
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
    writes: BatchWrite[],
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

/** Write one planned position inside the batch transaction. */
export function writePosition(
  tx: Prisma.TransactionClient,
  sellerId: number,
  w: BatchWrite,
): Promise<WrittenPosition> {
  return w.kind === 'create'
    ? createPosition(tx, sellerId, w)
    : syncStock(tx, sellerId, w);
}

/** The unique key of a position: (seller, DRIVERS_VILLAGE_1C, code_1c). */
export const stockKey = (sellerId: number, code1c: string) => ({
  sellerId_sourceSystem_sourceCode: {
    sellerId,
    sourceSystem: DRIVERS_VILLAGE_SOURCE_SYSTEM,
    sourceCode: code1c,
  },
});

/**
 * Initial creation of a position: product, its fitment links, stock. Refuses
 * (and so rolls the batch back) when the code already has a position — one
 * that appeared after planning — rather than touching it.
 */
async function createPosition(
  tx: Prisma.TransactionClient,
  sellerId: number,
  w: PositionWrite,
): Promise<WrittenPosition> {
  const existing = await tx.stock.findUnique({
    where: stockKey(sellerId, w.code1c),
    select: { id: true },
  });
  if (existing)
    throw new Error(
      `code_1c "${w.code1c}" already has a position (stock ${existing.id}) that appeared after planning — re-run the import`,
    );

  // gmNumber stays NULL: it is the Telegram upsert key, so an imported product
  // can never be matched (and overwritten) by a wizard listing. No category
  // either: the position starts unclassified (the projection files it under
  // the fallback bucket). is_universal keeps its default (false): no file
  // cell ever states "fits every vehicle".
  const { id: productId } = await tx.product.create({
    data: { ...importOwnedProductData(w), kind: ProductKind.SPARE_PART },
    select: { id: true },
  });
  await addVehicleLinks(
    tx,
    productId,
    w.models.map((v) => ({ brand: v.make, model: v.model })),
  );
  await addMakeLinks(tx, productId, w.makes);

  // The already-normalized price, the quantity and the unit. A quantity the
  // file does not give is left out: the stock gets the column default
  // (stocks.quantity DEFAULT 1), which lives in the schema only. A quantity of
  // 0 is written as 0 — the position exists, out of stock.
  const stock = await tx.stock.create({
    data: {
      sellerId,
      sourceSystem: DRIVERS_VILLAGE_SOURCE_SYSTEM,
      sourceCode: w.code1c,
      productId,
      priceUzs: new Prisma.Decimal(w.priceUzs),
      ...(w.quantity === null ? {} : { quantity: w.quantity }),
      unit: w.unit,
    },
    select: { id: true },
  });
  return { code1c: w.code1c, stockId: stock.id, productId, created: true };
}

/**
 * Synchronization of a stored position: the price and/or the quantity of its
 * stock — the only columns it writes. The stock is looked up again by the
 * exact key and must still be the one planned, so a code can only ever write
 * its own position.
 */
async function syncStock(
  tx: Prisma.TransactionClient,
  sellerId: number,
  w: StockSync,
): Promise<WrittenPosition> {
  const stock = await tx.stock.findUnique({
    where: stockKey(sellerId, w.code1c),
    select: { id: true, productId: true },
  });
  if (!stock || stock.id !== w.stockId)
    throw new Error(
      `the position of code_1c "${w.code1c}" (stock ${w.stockId}) changed after planning — re-run the import`,
    );
  await tx.stock.update({
    where: { id: stock.id },
    data: {
      ...(w.priceUzs === null
        ? {}
        : { priceUzs: new Prisma.Decimal(w.priceUzs) }),
      ...(w.quantity === null ? {} : { quantity: w.quantity }),
    },
    select: { id: true },
  });
  return {
    code1c: w.code1c,
    stockId: stock.id,
    productId: stock.productId,
    created: false,
  };
}

/** ADD make-wide links (part_makes), never removing one. Idempotent. */
export async function addMakeLinks(
  tx: Prisma.TransactionClient,
  productId: number,
  makes: string[],
): Promise<void> {
  for (const make of makes) {
    const brand = await tx.brand.upsert({
      where: { name: make },
      update: {},
      create: { name: make },
      select: { id: true },
    });
    await tx.partMake.upsert({
      where: { partId_brandId: { partId: productId, brandId: brand.id } },
      update: {},
      create: { partId: productId, brandId: brand.id },
    });
  }
}

/**
 * The ONLY product columns the 1C import writes, and only when it creates the
 * product. A column missing here is never set by an import: the category ids
 * and their main/vehicle enum mirrors, photos, image_url, description,
 * rating, kind, package form, oil/antifreeze attributes.
 */
function importOwnedProductData(w: PositionWrite) {
  return {
    title: w.product.title,
    gmNumbers: w.product.gmNumbers,
    sourcePartNumber: w.product.sourcePartNumber,
    oemNumbers: w.product.oemNumbers,
    ...numberLabels(w.product.gmNumbers, w.product.oemNumbers),
  };
}
