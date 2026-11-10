// LOW-ING-015: the Telegram commit's gallery replacement is atomic under a lock
// on the product row. SEC-003 stays rolled back: no ownership check is involved.

import { TelegramService } from './telegram.service';

type Image = {
  productId: number;
  url: string;
  sortOrder: number;
  isPrimary: boolean;
};

/** One product's gallery in memory, with real transaction semantics. */
function world(initial: string[]) {
  let images: Image[] = initial.map((url, i) => ({
    productId: 1,
    url,
    sortOrder: i,
    isPrimary: i === 0,
  }));
  let imageUrl: string | null = initial[0] ?? null;
  let queue: Promise<unknown> = Promise.resolve();
  const locks: number[] = [];
  let failCreate = false;

  const prisma = {
    $transaction: (work: (tx: unknown) => Promise<unknown>) => {
      const run = queue.then(async () => {
        // Each transaction works on a copy that is kept only if it commits.
        let draft = [...images];
        let draftUrl = imageUrl;
        const tx = {
          $queryRaw: async (sql: TemplateStringsArray, id: number) => {
            if (sql.join('?').includes('FOR UPDATE')) locks.push(id);
            return [];
          },
          productImage: {
            deleteMany: async () => {
              draft = [];
              // Let the other commit try to run in between.
              await new Promise((r) => setImmediate(r));
            },
            createMany: async ({ data }: { data: Image[] }) => {
              if (failCreate) throw new Error('db blip');
              draft.push(...data);
            },
          },
          product: {
            update: async ({ data }: { data: { imageUrl: string | null } }) => {
              draftUrl = data.imageUrl;
            },
          },
        };
        const result = await work(tx);
        images = draft;
        imageUrl = draftUrl;
        return result;
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
  const service = Object.create(TelegramService.prototype) as TelegramService;
  (service as unknown as { prisma: unknown }).prisma = prisma;
  const replace = (urls: string[]) =>
    (
      service as unknown as {
        replaceProductGallery(id: number, urls: string[]): Promise<void>;
      }
    ).replaceProductGallery(1, urls);
  return {
    replace,
    images: () => images,
    imageUrl: () => imageUrl,
    locks,
    failNextCreate: () => (failCreate = true),
  };
}

describe('Telegram gallery replacement', () => {
  it('two concurrent commits on one shared product leave one gallery with one primary image', async () => {
    const w = world(['old-1', 'old-2']);
    await Promise.all([
      w.replace(['a-1', 'a-2', 'a-3']),
      w.replace(['b-1', 'b-2']),
    ]);

    const urls = w.images().map((i) => i.url);
    expect(urls).toEqual(['b-1', 'b-2']);
    expect(w.images().filter((i) => i.isPrimary)).toHaveLength(1);
    expect(w.imageUrl()).toBe('b-1');
    expect(w.locks).toEqual([1, 1]);
  });

  it('a failed replacement leaves the previous gallery untouched', async () => {
    const w = world(['old-1', 'old-2']);
    w.failNextCreate();
    await expect(w.replace(['new-1'])).rejects.toThrow('db blip');
    expect(w.images().map((i) => i.url)).toEqual(['old-1', 'old-2']);
    expect(w.imageUrl()).toBe('old-1');
  });

  it("keeps the seller's order, first image primary", async () => {
    const w = world([]);
    await w.replace(['x', 'y', 'z']);
    expect(w.images()).toEqual([
      { productId: 1, url: 'x', sortOrder: 0, isPrimary: true },
      { productId: 1, url: 'y', sortOrder: 1, isPrimary: false },
      { productId: 1, url: 'z', sortOrder: 2, isPrimary: false },
    ]);
  });
});
