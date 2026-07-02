// Focused tests for the confirmation-session state machine added to
// TelegramService: one pending product per user, replacement, expiry, and the
// commit/cancel behaviors (DB write happens only on commit).
//
// The bot itself is never launched here; we construct the service with stub
// dependencies and drive the private confirmation helpers directly.

import { Decimal } from '@prisma/client/runtime/library';
import type { ParseOutcome } from '../ai/part-parser.types';
import { TelegramService } from './telegram.service';

// Surface just the private members we drive in these tests. We build the
// instance from the prototype and cast through `unknown`, so this stands alone
// rather than intersecting TelegramService (whose private members would
// otherwise collapse the intersection to `never`).
interface AnyService {
  pending: Map<number, unknown>;
  setPending: (ctx: unknown, draft: unknown) => void;
  discardPending: (tgUserId: number) => Promise<void>;
  commitPending: (ctx: unknown, tgUserId: number) => Promise<void>;
}

const metadata: ParseOutcome = {
  title: 'Магнитола для Nexia 3',
  description: 'Производство Корея, новая',
  brand: 'Chevrolet',
  models: ['Nexia 3'],
  gm_number: '96234567',
  price: 450000,
  source: 'structured',
  confidence: 1,
};

function draft(tgUserId: number, publicIds = ['mator/products/abc']) {
  return {
    sellerId: 7,
    tgUserId,
    metadata,
    title: metadata.title as string,
    processedUrls: publicIds.map((_, i) => `https://cdn/img${i}.webp`),
    publicIds,
    price: new Decimal(450000),
  };
}

// Minimal Prisma stub recording the writes commitPending performs.
function makePrisma() {
  const calls: string[] = [];
  const upsert = (name: string, ret: unknown) => async () => {
    calls.push(name);
    return ret;
  };
  return {
    calls,
    brand: { upsert: upsert('brand', { id: 1 }) },
    carModel: { upsert: upsert('carModel', { id: 2 }) },
    product: { upsert: upsert('product', { id: 100 }) },
    productImage: {
      deleteMany: upsert('productImage.deleteMany', { count: 0 }),
      createMany: upsert('productImage.createMany', { count: 1 }),
    },
    partModel: { upsert: upsert('partModel', {}) },
    stock: { upsert: upsert('stock', { id: 500 }) },
  };
}

function makeCtx() {
  // `replies` captures every user-visible string, including a single-photo
  // success caption (which the bot sends via replyWithPhoto's caption arg).
  const replies: string[] = [];
  return {
    replies,
    reply: async (text: string) => {
      replies.push(text);
      return {} as unknown;
    },
    replyWithPhoto: async (_media: unknown, extra?: { caption?: string }) => {
      if (extra?.caption) replies.push(extra.caption);
      return {} as unknown;
    },
    replyWithMediaGroup: async () => ({}) as unknown,
  };
}

// Cloudinary stub recording which public_ids were requested for deletion.
function makeCloudinary() {
  const deleted: string[] = [];
  return {
    deleted,
    deleteAssets: async (publicIds: string[]) => {
      deleted.push(...publicIds);
    },
  };
}

function makeService(prisma: unknown, cloudinary: unknown): AnyService {
  // Bypass the constructor's Nest DI wiring — we only exercise the private
  // confirmation helpers, which depend on `prisma`, `cloudinary`, and `pending`.
  const svc = Object.create(TelegramService.prototype) as unknown as AnyService;
  Object.assign(svc, {
    logger: { log() {}, warn() {}, error() {} },
    prisma,
    cloudinary,
    pending: new Map<number, unknown>(),
  });
  return svc;
}

describe('TelegramService — confirmation session', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('stores one pending product per user', () => {
    const svc = makeService(makePrisma(), makeCloudinary());
    const ctx = makeCtx();
    svc.setPending(ctx, draft(1));
    expect(svc.pending.has(1)).toBe(true);
    expect(svc.pending.size).toBe(1);
  });

  it('replaces an existing pending product and notifies the user', () => {
    const svc = makeService(makePrisma(), makeCloudinary());
    const ctx = makeCtx();
    svc.setPending(ctx, draft(1));
    svc.setPending(ctx, draft(1)); // second draft for same user
    expect(svc.pending.size).toBe(1);
    expect(ctx.replies.some((r) => r.includes('заменён'))).toBe(true);
  });

  it('expires a pending product automatically after the TTL', () => {
    const svc = makeService(makePrisma(), makeCloudinary());
    svc.setPending(makeCtx(), draft(1));
    expect(svc.pending.has(1)).toBe(true);
    jest.advanceTimersByTime(10 * 60 * 1000); // 10 minutes
    expect(svc.pending.has(1)).toBe(false);
  });

  it('commit writes the product to the DB and clears the pending session', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma, makeCloudinary());
    const ctx = makeCtx();
    svc.setPending(ctx, draft(1));

    await svc.commitPending(ctx, 1);

    // The full write sequence ran…
    expect(prisma.calls).toEqual([
      'brand',
      'carModel',
      'product',
      'productImage.deleteMany',
      'productImage.createMany',
      'partModel',
      'stock',
    ]);
    // …and the session is consumed.
    expect(svc.pending.has(1)).toBe(false);
    // …and the success message is the simple confirmation (no product details).
    expect(ctx.replies.some((r) => r.includes('Товар успешно добавлен'))).toBe(true);
    expect(ctx.replies.some((r) => r.includes('Название'))).toBe(false);
    expect(ctx.replies.some((r) => r.includes('OEM'))).toBe(false);
    expect(ctx.replies.some((r) => r.includes('Product ID'))).toBe(false);
  });

  it('commit with nothing pending tells the user instead of writing', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma, makeCloudinary());
    const ctx = makeCtx();

    await svc.commitPending(ctx, 1);

    expect(prisma.calls).toEqual([]);
    expect(ctx.replies.some((r) => r.includes('Нет товара для подтверждения'))).toBe(true);
  });

  it('a double commit writes only once (session consumed on first commit)', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma, makeCloudinary());
    const ctx = makeCtx();
    svc.setPending(ctx, draft(1));

    await svc.commitPending(ctx, 1);
    const afterFirst = prisma.calls.length;
    await svc.commitPending(ctx, 1); // second tap — nothing pending now

    expect(prisma.calls.length).toBe(afterFirst); // no additional writes
  });

  // ── Cloudinary asset cleanup ────────────────────────────────────────────────
  it('cancel deletes the uploaded Cloudinary assets (no DB write)', async () => {
    const prisma = makePrisma();
    const cloudinary = makeCloudinary();
    const svc = makeService(prisma, cloudinary);
    svc.setPending(makeCtx(), draft(1, ['id-a', 'id-b']));

    await svc.discardPending(1); // what the ❌ handler calls

    expect(svc.pending.has(1)).toBe(false);
    expect(cloudinary.deleted).toEqual(['id-a', 'id-b']);
    expect(prisma.calls).toEqual([]); // nothing written
  });

  it('expiration deletes the uploaded Cloudinary assets', async () => {
    const cloudinary = makeCloudinary();
    const svc = makeService(makePrisma(), cloudinary);
    svc.setPending(makeCtx(), draft(1, ['id-x']));

    jest.advanceTimersByTime(10 * 60 * 1000);
    await Promise.resolve(); // let the async discard settle

    expect(svc.pending.has(1)).toBe(false);
    expect(cloudinary.deleted).toEqual(['id-x']);
  });

  it('replacement deletes the OLD pending assets (keeps the new ones)', async () => {
    const cloudinary = makeCloudinary();
    const svc = makeService(makePrisma(), cloudinary);
    const ctx = makeCtx();
    svc.setPending(ctx, draft(1, ['old-1', 'old-2']));
    svc.setPending(ctx, draft(1, ['new-1']));
    await Promise.resolve();

    expect(cloudinary.deleted).toEqual(['old-1', 'old-2']); // only the old ones
    expect(svc.pending.size).toBe(1); // the new draft is retained
  });

  it('successful confirmation KEEPS the uploaded assets (no deletion)', async () => {
    const cloudinary = makeCloudinary();
    const svc = makeService(makePrisma(), cloudinary);
    const ctx = makeCtx();
    svc.setPending(ctx, draft(1, ['keep-1', 'keep-2']));

    await svc.commitPending(ctx, 1);

    expect(cloudinary.deleted).toEqual([]); // assets are NOT deleted on commit
  });
});
