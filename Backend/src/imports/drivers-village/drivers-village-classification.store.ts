/**
 * Persistence boundary of the Driver's Village classification import.
 *
 * Reads: the category tree, and the stored positions named by the file — found
 * by their exact (seller, DRIVERS_VILLAGE_1C, code_1c) only.
 * Writes (applyClassification, inside one transaction per batch): the
 * product's classification columns (category_id, vehicle_category_id,
 * main_category, vehicle_category — guarded by a compare-and-set on the
 * catalog part's category), is_universal = false when the file names
 * vehicles for an import-universal product, and ADDED part_models /
 * part_makes (plus brands / car_models reference rows). Never: prices, stock,
 * names, numbers, photos, catalog settings, fitment_bindings,
 * part_compatibilities, categories themselves, and no link is ever removed.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { CatalogProjectionService } from '../../catalog/projection/catalog-projection.service';
import { addVehicleLinks } from '../../telegram/vehicle-links';
import {
  DRIVERS_VILLAGE_SOURCE_SYSTEM,
  IMPORT_LIMITS,
} from './drivers-village.constants';
import type {
  CategoryNode,
  ClassificationTarget,
  ClassificationWrite,
} from './drivers-village-classification.rules';
import type { EnvironmentStore } from './drivers-village-environment';
import {
  addMakeLinks,
  PrismaDriversVillageStore,
  stockKey,
} from './drivers-village.store';

export interface ClassificationWritten {
  code1c: string;
  stockId: number;
  /** False when the catalog part's category changed after planning. */
  categoryWritten: boolean;
}

export interface ClassificationStore extends EnvironmentStore {
  loadCategoryTree(): Promise<CategoryNode[]>;
  /** Stored positions of this seller, keyed by their exact code_1c. */
  loadTargets(
    sellerId: number,
    codes: string[],
  ): Promise<Map<string, ClassificationTarget>>;
  /** Write one batch atomically: all positions or none. */
  applyClassificationBatch(
    sellerId: number,
    writes: ClassificationWrite[],
  ): Promise<ClassificationWritten[]>;
}

const LOOKUP_CHUNK = 1000;

export class PrismaClassificationStore implements ClassificationStore {
  private readonly base: PrismaDriversVillageStore;

  constructor(private readonly prisma: PrismaClient) {
    this.base = new PrismaDriversVillageStore(prisma);
  }

  schemaReady() {
    return this.base.schemaReady();
  }

  findCatalogSeller(id: string) {
    return this.base.findCatalogSeller(id);
  }

  findLinkedSeller(catalogSellerId: string) {
    return this.base.findLinkedSeller(catalogSellerId);
  }

  loadCategoryTree(): Promise<CategoryNode[]> {
    return this.prisma.partCategory.findMany({
      select: { id: true, parentId: true, isActive: true },
    });
  }

  async loadTargets(
    sellerId: number,
    codes: string[],
  ): Promise<Map<string, ClassificationTarget>> {
    const out = new Map<string, ClassificationTarget>();
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
          productId: true,
          product: {
            select: {
              isUniversal: true,
              partModels: {
                select: {
                  model: {
                    select: { name: true, brand: { select: { name: true } } },
                  },
                },
              },
              partMakes: { select: { brand: { select: { name: true } } } },
            },
          },
        },
      });
      const parts = new Map(
        (
          await this.prisma.catalogPart.findMany({
            where: {
              id: {
                in: stocks.map((s) =>
                  CatalogProjectionService.catalogPartId(s.id),
                ),
              },
            },
            select: {
              id: true,
              categoryId: true,
              _count: { select: { fitmentBindings: true } },
            },
          })
        ).map((p) => [p.id, p]),
      );
      for (const s of stocks) {
        if (!s.sourceCode) continue;
        const part = parts.get(CatalogProjectionService.catalogPartId(s.id));
        out.set(s.sourceCode, {
          stockId: s.id,
          productId: s.productId,
          code1c: s.sourceCode,
          isUniversal: s.product.isUniversal,
          partCategoryId: part?.categoryId ?? null,
          models: s.product.partModels.map(
            (pm) => `${pm.model.brand.name}|${pm.model.name}`,
          ),
          makes: s.product.partMakes.map((pm) => pm.brand.name),
          curatedBindings: part?._count.fitmentBindings ?? 0,
        });
      }
    }
    return out;
  }

  applyClassificationBatch(
    sellerId: number,
    writes: ClassificationWrite[],
  ): Promise<ClassificationWritten[]> {
    return this.prisma.$transaction(
      async (tx) => {
        const written: ClassificationWritten[] = [];
        for (const w of writes)
          written.push(await applyClassification(tx, sellerId, w));
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
 * Write one position's classification inside the batch transaction. The
 * stock is found again by its exact key and must still be the one planned.
 * The category is written only while the catalog part still has the category
 * it had when planning: an operator's change made meanwhile wins (the
 * position is reported, nothing of its category is written).
 */
export async function applyClassification(
  tx: Prisma.TransactionClient,
  sellerId: number,
  w: ClassificationWrite,
): Promise<ClassificationWritten> {
  const stock = await tx.stock.findUnique({
    where: stockKey(sellerId, w.code1c),
    select: { id: true, productId: true },
  });
  if (!stock || stock.id !== w.stockId || stock.productId !== w.productId)
    throw new Error(
      `the position of code_1c "${w.code1c}" (stock ${w.stockId}) changed after planning — re-run the classification import`,
    );

  let categoryWritten = false;
  if (w.category) {
    const part = await tx.catalogPart.findUnique({
      where: { id: CatalogProjectionService.catalogPartId(stock.id) },
      select: { categoryId: true },
    });
    if ((part?.categoryId ?? null) === w.category.expectedPartCategory) {
      await tx.product.update({
        where: { id: stock.productId },
        data: w.category.set,
        select: { id: true },
      });
      categoryWritten = true;
    }
  }
  if (w.clearUniversal)
    await tx.product.update({
      where: { id: stock.productId },
      data: { isUniversal: false },
      select: { id: true },
    });
  await addVehicleLinks(
    tx,
    stock.productId,
    w.addModels.map((m) => ({ brand: m.make, model: m.model })),
  );
  await addMakeLinks(tx, stock.productId, w.addMakes);
  return { code1c: w.code1c, stockId: stock.id, categoryWritten };
}
