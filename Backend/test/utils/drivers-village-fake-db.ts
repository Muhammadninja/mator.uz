/* eslint-disable @typescript-eslint/require-await -- the fake mirrors Prisma's
   async API; its in-memory bodies have nothing to await. */
/**
 * In-memory stand-in for the slice of Prisma the Driver's Village importer
 * uses, plus a DriversVillageStore built on it that runs the REAL
 * `writePosition` — so specs exercise the production write logic (keys,
 * reconciliation, photo preservation) without a database.
 *
 * Test-only: lives under test/, which the production build excludes. It holds
 * isolated fixtures (a 'drivers-village' dealer, a linked seller, vehicles);
 * nothing here is seed data for any real database.
 */
import type { Prisma } from '@prisma/client';
import type {
  DriversVillageStore,
  WrittenPosition,
} from '../../src/imports/drivers-village/drivers-village.store';
import { writePosition } from '../../src/imports/drivers-village/drivers-village.store';
import type {
  ExistingPosition,
  PositionWrite,
  VehicleReference,
} from '../../src/imports/drivers-village/drivers-village.types';

interface FakeProduct {
  id: number;
  gmNumber: string | null;
  title: string;
  gmNumbers: string[];
  sourcePartNumber?: string | null;
  oemNumbers: string[];
  categoryId: string | null;
  vehicleCategoryId: string | null;
  mainCategory: string | null;
  vehicleCategory: string | null;
  isUniversal: boolean;
  imageUrl: string | null;
  description: string | null;
  [key: string]: unknown;
}

/** A buyer-side catalog_parts row: only what the import specs look at. */
export interface FakeCatalogPart {
  id: string;
  categoryId: string;
  [key: string]: unknown;
}

interface FakeStock {
  id: number;
  sellerId: number;
  productId: number;
  sourceSystem: string | null;
  sourceCode: string | null;
  priceUzs: string;
  quantity: number;
  unit: string | null;
}

export interface FakeState {
  catalogSellers: { id: string; name: string }[];
  sellers: {
    id: number;
    sellerType: 'TELEGRAM' | 'BUSINESS';
    tgId: bigint | null;
    status: string;
    catalogSellerId: string | null;
  }[];
  products: FakeProduct[];
  stocks: FakeStock[];
  brands: { id: number; name: string }[];
  carModels: { id: number; brandId: number; name: string }[];
  partModels: { partId: number; modelId: number }[];
  partMakes: { partId: number; brandId: number }[];
  productImages: { productId: number; url: string }[];
  catalogParts: FakeCatalogPart[];
  /** Buyer vehicle reference names (vehicle_makes / vehicle_models). */
  vehicleReference: VehicleReference;
  seq: number;
}

const str = (v: unknown): string => (v as { toString(): string }).toString();

export class FakeDb {
  state: FakeState;
  /** Every model.method the write path invoked, in order. */
  calls: string[] = [];

  constructor(seed: Partial<FakeState> = {}) {
    this.state = {
      catalogSellers: [],
      sellers: [],
      products: [],
      stocks: [],
      brands: [],
      carModels: [],
      partModels: [],
      partMakes: [],
      productImages: [],
      catalogParts: [],
      vehicleReference: { makes: [], models: [] },
      seq: 1000,
      ...seed,
    };
  }

  private next(): number {
    this.state.seq += 1;
    return this.state.seq;
  }

  /** The transaction client surface writePosition + persistVehicleLinks use. */
  get tx(): Prisma.TransactionClient {
    const s = () => this.state;
    const log = (c: string) => this.calls.push(c);
    const tx = {
      stock: {
        findUnique: async ({
          where,
        }: {
          where: {
            sellerId_sourceSystem_sourceCode: {
              sellerId: number;
              sourceSystem: string;
              sourceCode: string;
            };
          };
        }) => {
          log('stock.findUnique');
          const k = where.sellerId_sourceSystem_sourceCode;
          const st = s().stocks.find(
            (x) =>
              x.sellerId === k.sellerId &&
              x.sourceSystem === k.sourceSystem &&
              x.sourceCode === k.sourceCode,
          );
          return st ? { id: st.id, productId: st.productId } : null;
        },
        create: async ({ data }: { data: Record<string, unknown> }) => {
          log('stock.create');
          const clash = s().stocks.some(
            (x) =>
              x.sellerId === data.sellerId &&
              x.sourceSystem === data.sourceSystem &&
              x.sourceCode === data.sourceCode,
          );
          if (clash)
            throw new Error(
              'Unique constraint failed: stocks_seller_id_source_system_source_code_key',
            );
          const row: FakeStock = {
            id: this.next(),
            sellerId: data.sellerId as number,
            productId: data.productId as number,
            sourceSystem: data.sourceSystem as string,
            sourceCode: data.sourceCode as string,
            priceUzs: str(data.priceUzs),
            // The column default, as the database applies it (DEFAULT 1).
            quantity: (data.quantity as number | undefined) ?? 1,
            unit: data.unit as string,
          };
          s().stocks.push(row);
          return { id: row.id };
        },
        update: async ({
          where,
          data,
        }: {
          where: { id: number };
          data: Record<string, unknown>;
        }) => {
          log('stock.update');
          const st = s().stocks.find((x) => x.id === where.id)!;
          if (
            data.sourceCode !== undefined &&
            s().stocks.some(
              (x) =>
                x.id !== st.id &&
                x.sellerId === st.sellerId &&
                x.sourceSystem === st.sourceSystem &&
                x.sourceCode === data.sourceCode,
            )
          )
            throw new Error(
              'Unique constraint failed: stocks_seller_id_source_system_source_code_key',
            );
          // Like an UPDATE: only the columns the write names change.
          Object.assign(st, {
            ...data,
            ...(data.priceUzs === undefined
              ? {}
              : { priceUzs: str(data.priceUzs) }),
          });
          return { id: st.id };
        },
      },
      product: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          log('product.create');
          // Column defaults, as the database applies them: every column the
          // write does not name — the category among them — starts NULL.
          const p = {
            gmNumber: null,
            imageUrl: null,
            description: null,
            categoryId: null,
            vehicleCategoryId: null,
            mainCategory: null,
            vehicleCategory: null,
            ...data,
            id: this.next(),
          } as FakeProduct;
          s().products.push(p);
          return { id: p.id };
        },
        update: async ({
          where,
          data,
        }: {
          where: { id: number };
          data: Record<string, unknown>;
        }) => {
          log('product.update');
          const p = s().products.find((x) => x.id === where.id)!;
          Object.assign(p, data);
          return { id: p.id };
        },
      },
      brand: {
        upsert: async ({ where }: { where: { name: string } }) => {
          log('brand.upsert');
          let b = s().brands.find((x) => x.name === where.name);
          if (!b) s().brands.push((b = { id: this.next(), name: where.name }));
          return { id: b.id };
        },
      },
      carModel: {
        upsert: async ({
          where,
        }: {
          where: { brandId_name: { brandId: number; name: string } };
        }) => {
          log('carModel.upsert');
          const k = where.brandId_name;
          let m = s().carModels.find(
            (x) => x.brandId === k.brandId && x.name === k.name,
          );
          if (!m) s().carModels.push((m = { id: this.next(), ...k }));
          return { id: m.id };
        },
      },
      partModel: {
        upsert: async ({
          where,
        }: {
          where: { partId_modelId: { partId: number; modelId: number } };
        }) => {
          log('partModel.upsert');
          const k = where.partId_modelId;
          if (
            !s().partModels.some(
              (x) => x.partId === k.partId && x.modelId === k.modelId,
            )
          )
            s().partModels.push({ ...k });
          return {};
        },
        deleteMany: async ({ where }: { where: { partId: number } }) => {
          log('partModel.deleteMany');
          s().partModels = s().partModels.filter(
            (x) => x.partId !== where.partId,
          );
          return {};
        },
      },
      partMake: {
        deleteMany: async ({ where }: { where: { partId: number } }) => {
          log('partMake.deleteMany');
          s().partMakes = s().partMakes.filter(
            (x) => x.partId !== where.partId,
          );
          return {};
        },
        create: async ({
          data,
        }: {
          data: { partId: number; brandId: number };
        }) => {
          log('partMake.create');
          if (
            s().partMakes.some(
              (x) => x.partId === data.partId && x.brandId === data.brandId,
            )
          )
            throw new Error('duplicate part_makes');
          s().partMakes.push({ ...data });
          return {};
        },
      },
    };
    return tx as unknown as Prisma.TransactionClient;
  }
}

export interface FakeStoreOptions {
  schemaReady?: boolean;
  /** Throw inside applyBatch when writing this code_1c (after earlier rows of the batch). */
  failOnCode?: string;
}

export class FakeDriversVillageStore implements DriversVillageStore {
  applyBatchCalls = 0;

  constructor(
    readonly db: FakeDb,
    private readonly opts: FakeStoreOptions = {},
  ) {}

  async schemaReady() {
    return this.opts.schemaReady ?? true;
  }

  async findCatalogSeller(id: string) {
    return this.db.state.catalogSellers.find((c) => c.id === id) ?? null;
  }

  async findLinkedSeller(catalogSellerId: string) {
    const s = this.db.state.sellers.find(
      (x) => x.catalogSellerId === catalogSellerId,
    );
    return s ? { id: s.id, status: s.status, sellerType: s.sellerType } : null;
  }

  async loadVehicleReference() {
    return this.db.state.vehicleReference;
  }

  async loadPositions(sellerId: number, codes: string[]) {
    const st = this.db.state;
    const out = new Map<string, ExistingPosition>();
    for (const s of st.stocks) {
      if (
        s.sellerId !== sellerId ||
        !s.sourceCode ||
        !codes.includes(s.sourceCode)
      )
        continue;
      const p = st.products.find((x) => x.id === s.productId)!;
      const models = st.partModels
        .filter((pm) => pm.partId === p.id)
        .map((pm) => {
          const m = st.carModels.find((c) => c.id === pm.modelId)!;
          return `${st.brands.find((b) => b.id === m.brandId)!.name}|${m.name}`;
        });
      const makes = st.partMakes
        .filter((pm) => pm.partId === p.id)
        .map((pm) => st.brands.find((b) => b.id === pm.brandId)!.name);
      const part = st.catalogParts.find((c) => c.id === `part_stock_${s.id}`);
      out.set(s.sourceCode, {
        stockId: s.id,
        productId: p.id,
        sourceCode: s.sourceCode,
        priceUzs: s.priceUzs,
        quantity: s.quantity,
        unit: s.unit,
        title: p.title,
        gmNumbers: p.gmNumbers,
        sourcePartNumber: p.sourcePartNumber ?? null,
        oemNumbers: p.oemNumbers,
        categoryId: part?.categoryId ?? p.categoryId,
        isUniversal: p.isUniversal,
        models: models.sort(),
        makes: makes.sort(),
        imageCount: st.productImages.filter((i) => i.productId === p.id).length,
        hasCatalogPart: part !== undefined,
      });
    }
    return out;
  }

  async loadAllSourceCodes(sellerId: number) {
    return this.db.state.stocks
      .filter((s) => s.sellerId === sellerId && s.sourceCode)
      .map((s) => s.sourceCode as string);
  }

  /** Atomic like a real transaction: any failure restores the prior state. */
  async applyBatch(
    sellerId: number,
    writes: PositionWrite[],
  ): Promise<WrittenPosition[]> {
    this.applyBatchCalls += 1;
    const snapshot = structuredClone(this.db.state);
    try {
      const out: WrittenPosition[] = [];
      for (const w of writes) {
        if (w.code1c === this.opts.failOnCode)
          throw new Error(`injected failure at ${w.code1c}`);
        out.push(await writePosition(this.db.tx, sellerId, w));
      }
      return out;
    } catch (error) {
      this.db.state = snapshot;
      throw error;
    }
  }
}

/**
 * Projector double: marks the CatalogPart as present (in the product's
 * category, or the fallback bucket), optionally failing. Specs that need the
 * real Stock → CatalogPart mapping use CatalogProjectionService over
 * fakeCatalogPrisma (drivers-village-fake-catalog.ts) instead.
 */
export class FakeProjector {
  projected: number[] = [];
  constructor(
    private readonly db: FakeDb,
    private readonly failFor: Set<number> = new Set(),
  ) {}

  async projectStock(stockId: number): Promise<string | null> {
    if (this.failFor.has(stockId))
      throw new Error(`projection failed for ${stockId}`);
    this.projected.push(stockId);
    const id = `part_stock_${stockId}`;
    if (!this.db.state.catalogParts.some((c) => c.id === id)) {
      const stock = this.db.state.stocks.find((s) => s.id === stockId)!;
      const product = this.db.state.products.find(
        (p) => p.id === stock.productId,
      )!;
      this.db.state.catalogParts.push({
        id,
        categoryId: product.categoryId ?? 'cat_uncategorized',
      });
    }
    return id;
  }
}

/** Isolated fixture: the dealer, its linked supply seller, vehicle names. */
export function driversVillageFixture(): Partial<FakeState> {
  return {
    catalogSellers: [{ id: 'drivers-village', name: 'Drivers Village' }],
    // The intended production shape: a BUSINESS seller with no Telegram id,
    // linked to the curated dealer.
    sellers: [
      {
        id: 7,
        sellerType: 'BUSINESS',
        tgId: null,
        status: 'ACTIVE',
        catalogSellerId: 'drivers-village',
      },
    ],
    // Names as the buyer reference spells them (garage fitment matches names).
    vehicleReference: {
      makes: ['Chevrolet', 'Skoda'],
      models: [
        'Chevrolet|Cobalt',
        'Chevrolet|Damas',
        'Chevrolet|Labo',
        'Chevrolet|Malibu',
        'Chevrolet|Tracker',
      ],
    },
  };
}
