/* eslint-disable @typescript-eslint/require-await -- in-memory fakes mirror async APIs */
/**
 * In-memory world for the Driver's Village photo-update specs: a Prisma slice
 * (sellers, stocks, products, product photos) and a ProductDraftService slice
 * (drafts + image rows), both stateful, so the REAL DriversVillagePhotoService,
 * DraftCoordinator and TelegramService handlers run against it end to end.
 *
 * Test-only (under test/, excluded from the build). Isolated fixtures — never
 * seed data for a real database.
 */
import type { PrismaService } from '../../src/prisma/prisma.service';

export interface WProduct {
  id: number;
  title: string;
  description: string | null;
  gmNumber: string | null;
  gmNumbers: string[];
  oemNumbers: string[];
  categoryId: string | null;
  vehicleCategoryId: string | null;
  isUniversal: boolean;
  imageUrl: string | null;
}
export interface WStock {
  id: number;
  sellerId: number;
  productId: number;
  sourceSystem: string | null;
  sourceCode: string | null;
  priceUzs: string;
  quantity: number;
  unit: string | null;
}
export interface WImage {
  productId: number;
  url: string;
  sortOrder: number;
  isPrimary: boolean;
}
export interface WSeller {
  id: number;
  sellerType: 'TELEGRAM' | 'BUSINESS';
  tgId: bigint | null;
  catalogSellerId: string | null;
  status: string;
}

export interface WorldState {
  sellers: WSeller[];
  products: WProduct[];
  stocks: WStock[];
  productImages: WImage[];
}

export const DV_CODE = '00-00001431';

/** Driver's Village position #500 (product #100, two current photos) plus a
 *  Telegram seller's listing (#600 / product #200) carrying the SAME number. */
export function worldFixture(): WorldState {
  return {
    sellers: [
      {
        id: 7,
        sellerType: 'BUSINESS',
        tgId: null,
        catalogSellerId: 'drivers-village',
        status: 'ACTIVE',
      },
      {
        id: 1,
        sellerType: 'TELEGRAM',
        tgId: BigInt(555),
        catalogSellerId: null,
        status: 'ACTIVE',
      },
    ],
    products: [
      {
        id: 100,
        title: 'Амортизатор передний RH',
        description: null,
        gmNumber: null,
        gmNumbers: [],
        oemNumbers: ['96611630'],
        categoryId: 'shock-absorbers',
        vehicleCategoryId: 'suspension-and-steering',
        isUniversal: false,
        imageUrl: 'https://old/dv-0.jpg',
      },
      {
        id: 200,
        title: 'Амортизатор (Telegram)',
        description: null,
        gmNumber: '96611630',
        gmNumbers: [],
        oemNumbers: [],
        categoryId: 'shock-absorbers',
        vehicleCategoryId: 'suspension-and-steering',
        isUniversal: false,
        imageUrl: 'https://tg/0.jpg',
      },
    ],
    stocks: [
      {
        id: 500,
        sellerId: 7,
        productId: 100,
        sourceSystem: 'DRIVERS_VILLAGE_1C',
        sourceCode: DV_CODE,
        priceUzs: '490000',
        quantity: 8,
        unit: 'PCS',
      },
      {
        id: 600,
        sellerId: 1,
        productId: 200,
        sourceSystem: null,
        sourceCode: null,
        priceUzs: '100000',
        quantity: 1,
        unit: null,
      },
    ],
    productImages: [
      {
        productId: 100,
        url: 'https://old/dv-0.jpg',
        sortOrder: 0,
        isPrimary: true,
      },
      {
        productId: 100,
        url: 'https://old/dv-1.jpg',
        sortOrder: 1,
        isPrimary: false,
      },
      {
        productId: 200,
        url: 'https://tg/0.jpg',
        sortOrder: 0,
        isPrimary: true,
      },
    ],
  };
}

/** Stateful Prisma slice + a log of every write it received. */
export class FakePrisma {
  writes: string[] = [];
  reads: { model: string; where: unknown }[] = [];

  constructor(public state: WorldState = worldFixture()) {}

  private client() {
    const s = () => this.state;
    const write = (w: string) => this.writes.push(w);
    const read = (model: string, where: unknown) =>
      this.reads.push({ model, where });
    return {
      seller: {
        findUnique: async ({
          where,
        }: {
          where: { catalogSellerId: string };
        }) => {
          read('seller', where);
          return (
            s().sellers.find(
              (x) => x.catalogSellerId === where.catalogSellerId,
            ) ?? null
          );
        },
      },
      stock: {
        findUnique: async ({
          where,
        }: {
          where: {
            id?: number;
            sellerId_sourceSystem_sourceCode?: {
              sellerId: number;
              sourceSystem: string;
              sourceCode: string;
            };
          };
        }) => {
          read('stock', where);
          const k = where.sellerId_sourceSystem_sourceCode;
          const st = k
            ? s().stocks.find(
                (x) =>
                  x.sellerId === k.sellerId &&
                  x.sourceSystem === k.sourceSystem &&
                  x.sourceCode === k.sourceCode,
              )
            : s().stocks.find((x) => x.id === where.id);
          if (!st) return null;
          const p = s().products.find((x) => x.id === st.productId)!;
          return {
            ...st,
            product: {
              title: p.title,
              _count: {
                images: s().productImages.filter((i) => i.productId === p.id)
                  .length,
              },
            },
          };
        },
      },
      productImage: {
        deleteMany: async ({ where }: { where: { productId: number } }) => {
          write(`productImage.deleteMany:${where.productId}`);
          s().productImages = s().productImages.filter(
            (i) => i.productId !== where.productId,
          );
          return { count: 0 };
        },
        createMany: async ({ data }: { data: WImage[] }) => {
          write(`productImage.createMany:${data[0]?.productId}`);
          s().productImages.push(...data.map((d) => ({ ...d })));
          return { count: data.length };
        },
      },
      product: {
        update: async ({
          where,
          data,
        }: {
          where: { id: number };
          data: Partial<WProduct>;
        }) => {
          write(`product.update:${where.id}:${Object.keys(data).join(',')}`);
          Object.assign(
            s().products.find((x) => x.id === where.id)!,
            data,
          );
          return { id: where.id };
        },
      },
    };
  }

  /** The PrismaService stand-in, with an atomic $transaction. */
  get prisma(): PrismaService {
    const c = this.client();
    const tx = async <T>(fn: (t: unknown) => Promise<T>): Promise<T> => {
      const snapshot = structuredClone(this.state);
      try {
        return await fn(c);
      } catch (e) {
        this.state = snapshot;
        throw e;
      }
    };
    return { ...c, $transaction: tx } as unknown as PrismaService;
  }
}

export interface WDraftImage {
  id: string;
  draftId: string;
  sortOrder: number;
  status: 'PROCESSING' | 'READY' | 'FAILED';
  tgFileId: string;
  originalPublicId: string | null;
  processedPublicId: string | null;
  processedUrl: string | null;
  jobId: string | null;
}

/** Stateful ProductDraftService slice (the methods these flows call). */
export class FakeDrafts {
  drafts = new Map<
    string,
    Record<string, unknown> & { images: WDraftImage[] }
  >();
  private seq = 0;

  constructor(private readonly world: FakePrisma) {}

  createWithImages = jest.fn(
    async (p: {
      sellerId: number;
      tgId: bigint;
      formStep: string;
      expiresAt: Date;
      images: { sortOrder: number; tgFileId: string }[];
      targetStockId?: number;
    }) => {
      const id = `draft_${++this.seq}`;
      const draft = {
        id,
        sellerId: p.sellerId,
        tgId: p.tgId,
        status: 'CREATING',
        version: 0,
        formStep: p.formStep,
        targetStockId: p.targetStockId ?? null,
        kind: 'SPARE_PART',
        title: null,
        priceUzs: null,
        brand: null,
        model: null,
        category: null,
        categoryId: null,
        oilViscosity: null,
        oilType: null,
        oilVolumeMl: null,
        antifreezeWeightG: null,
        previewSentAt: null,
        expiresAt: p.expiresAt,
        images: p.images.map((img, i) => ({
          id: `${id}_img_${i}`,
          draftId: id,
          sortOrder: img.sortOrder,
          status: 'PROCESSING' as const,
          tgFileId: img.tgFileId,
          originalPublicId: null,
          processedPublicId: null,
          processedUrl: null,
          jobId: null,
        })),
      };
      this.drafts.set(id, draft);
      return structuredClone(draft);
    },
  );

  findWithImages = jest.fn(async (id: string) => {
    const d = this.drafts.get(id);
    return d
      ? structuredClone({
          ...d,
          images: [...d.images].sort((a, b) => a.sortOrder - b.sortOrder),
        })
      : null;
  });

  tryTransition = jest.fn(
    async (id: string, from: string, to: string, version: number) => {
      const d = this.drafts.get(id);
      if (!d || d.status !== from || d.version !== version) return false;
      d.status = to;
      d.version = version + 1;
      return true;
    },
  );

  claimPreviewSend = jest.fn(async (id: string) => {
    const d = this.drafts.get(id);
    if (!d || d.status !== 'READY_FOR_PREVIEW' || d.previewSentAt) return false;
    d.previewSentAt = new Date();
    d.version = (d.version as number) + 1;
    return true;
  });

  publishDraft = jest.fn(async (id: string) => {
    const d = this.drafts.get(id);
    if (!d || !['COMMITTING', 'READY_FOR_PREVIEW'].includes(d.status as string))
      return false;
    d.status = 'PUBLISHED';
    return true;
  });

  /** Same contract as the real one: never an asset a product photo claims. */
  collectPublicIds = jest.fn(async (id: string) => {
    const claimed = new Set(this.world.state.productImages.map((i) => i.url));
    const out: string[] = [];
    for (const img of this.drafts.get(id)?.images ?? []) {
      if (img.originalPublicId) out.push(img.originalPublicId);
      if (
        img.processedPublicId &&
        !(img.processedUrl && claimed.has(img.processedUrl))
      )
        out.push(img.processedPublicId);
    }
    return out;
  });

  collectOriginalPublicIds = jest.fn(async (id: string) =>
    (this.drafts.get(id)?.images ?? [])
      .filter((i) => i.originalPublicId)
      .map((i) => i.originalPublicId as string),
  );

  setImageJobId = jest.fn(async (imageId: string, jobId: string) => {
    for (const d of this.drafts.values())
      for (const i of d.images) if (i.id === imageId) i.jobId = jobId;
  });

  /** Stand-in for the BullMQ image worker: settle every row, READY or FAILED. */
  settle(id: string, outcome: 'READY' | 'FAILED' = 'READY'): void {
    for (const img of this.drafts.get(id)!.images) {
      img.status = outcome;
      img.originalPublicId = `orig_${img.tgFileId}`;
      if (outcome === 'READY') {
        img.processedPublicId = `proc_${img.tgFileId}`;
        img.processedUrl = `https://cdn/proc/${img.tgFileId}.jpg`;
      }
    }
  }
}
