/* eslint-disable @typescript-eslint/require-await -- the fake mirrors Prisma's
   async API; its in-memory bodies have nothing to await. */
/**
 * The slice of Prisma that CatalogProjectionService.projectStock uses, over the
 * same in-memory state as FakeDb — so an import spec can run the REAL
 * Stock → CatalogPart mapping end to end (e.g. that a category an operator set
 * on catalog_parts survives the next import) without a database.
 *
 * Like Prisma, a write is lazy: nothing happens until $transaction runs the
 * batch, in order. Test-only; lives under test/, outside the production build.
 */
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { FakeCatalogPart, FakeDb } from './drivers-village-fake-db';

/** A deferred write: runs once, when $transaction (or an await) asks for it. */
function lazy<T>(run: () => T): PromiseLike<T> {
  let started: Promise<T> | undefined;
  return {
    then: (onFulfilled, onRejected) =>
      (started ??= Promise.resolve().then(run)).then(onFulfilled, onRejected),
  };
}

type Row = Record<string, unknown>;

export interface FakeCatalogPrisma {
  prisma: PrismaService;
  /** catalog_part_fits / catalog_part_make_fits rows written so far. */
  fits: Row[];
  makeFits: Row[];
}

export function fakeCatalogPrisma(db: FakeDb): FakeCatalogPrisma {
  const st = () => db.state;
  const fits: Row[] = [];
  const makeFits: Row[] = [];
  const noop = () => lazy(() => ({}));

  const prisma = {
    stock: {
      findUnique: async ({ where }: { where: { id: number } }) => {
        const stock = st().stocks.find((s) => s.id === where.id);
        if (!stock) return null;
        const seller = st().sellers.find((s) => s.id === stock.sellerId)!;
        const product = st().products.find((p) => p.id === stock.productId)!;
        const brand = (id: number) => st().brands.find((b) => b.id === id)!;
        return {
          ...stock,
          seller: { storeName: null, marketName: null, ...seller },
          product: {
            // Columns the projection reads that an imported product leaves at
            // their database defaults.
            oemNumber: null,
            partBrand: null,
            originRegion: null,
            oilViscosity: null,
            oilType: null,
            oilVolumeMl: null,
            antifreezeWeightG: null,
            packageForm: null,
            ratingAvg: null,
            reviewCount: 0,
            ...product,
            images: st()
              .productImages.filter((i) => i.productId === product.id)
              .map((i, sortOrder) => ({ url: i.url, sortOrder })),
            partModels: st()
              .partModels.filter((pm) => pm.partId === product.id)
              .map((pm) => {
                const m = st().carModels.find((c) => c.id === pm.modelId)!;
                return { model: { name: m.name, brand: brand(m.brandId) } };
              }),
            partMakes: st()
              .partMakes.filter((pm) => pm.partId === product.id)
              .map((pm) => ({ brand: brand(pm.brandId) })),
          },
        };
      },
    },
    catalogSeller: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        st().catalogSellers.find((c) => c.id === where.id) ?? null,
      upsert: noop,
    },
    // The category tree only feeds main-category derivation for the home grid,
    // which these specs do not exercise.
    partCategory: { findMany: async () => [], upsert: noop },
    partBrand: { upsert: noop },
    catalogPart: {
      upsert: ({
        where,
        update,
        create,
      }: {
        where: { id: string };
        update: Row;
        create: Row;
      }) =>
        lazy(() => {
          const row = st().catalogParts.find((c) => c.id === where.id);
          // Like an UPSERT: an existing row changes only in the columns the
          // update names; everything else (an operator's edits) stays.
          if (row) Object.assign(row, update);
          else st().catalogParts.push({ ...create } as FakeCatalogPart);
          return {};
        }),
    },
    catalogPartFit: {
      deleteMany: ({ where }: { where: { partId: string } }) =>
        lazy(() => remove(fits, where.partId)),
      createMany: ({ data }: { data: Row[] }) => lazy(() => fits.push(...data)),
    },
    catalogPartMakeFit: {
      deleteMany: ({ where }: { where: { partId: string } }) =>
        lazy(() => remove(makeFits, where.partId)),
      createMany: ({ data }: { data: Row[] }) =>
        lazy(() => makeFits.push(...data)),
    },
    $transaction: async (ops: PromiseLike<unknown>[]) => Promise.all(ops),
  };
  return { prisma: prisma as unknown as PrismaService, fits, makeFits };
}

function remove(rows: Row[], partId: string): void {
  for (let i = rows.length - 1; i >= 0; i -= 1)
    if (rows[i].partId === partId) rows.splice(i, 1);
}
