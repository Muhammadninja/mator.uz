// Focused tests for the confirmation-session state machine added to
// TelegramService: one pending product per user, replacement, expiry, and the
// commit/cancel behaviors (DB write happens only on commit).
//
// The bot itself is never launched here; we construct the service with stub
// dependencies and drive the private confirmation helpers directly.

import { PartVehicleCategory } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import type { ParseOutcome } from '../ai/part-parser.types';
import { buildSessionFromPending, TelegramService } from './telegram.service';
import { WizardSessionStore, WizardStep } from './product-wizard';

// Surface just the private members we drive in these tests. We build the
// instance from the prototype and cast through `unknown`, so this stands alone
// rather than intersecting TelegramService (whose private members would
// otherwise collapse the intersection to `never`).
interface AnyService {
  pending: Map<number, unknown>;
  wizard: WizardSessionStore;
  sessionExpiry: Map<number, NodeJS.Timeout>;
  touchSession: (tgUserId: number) => void;
  setPending: (ctx: unknown, draft: unknown) => void;
  discardPending: (tgUserId: number) => Promise<void>;
  discardSessionPhotos: (tgUserId: number) => Promise<void>;
  commitPending: (ctx: unknown, tgUserId: number) => Promise<void>;
  reopenFromPreview: (
    ctx: unknown,
    tgUserId: number,
    target: WizardStep,
  ) => Promise<void>;
  finalizeToPreview: (
    ctx: unknown,
    tgUserId: number,
    session: unknown,
    sellerId: number,
  ) => Promise<void>;
  sendPreview: (
    ctx: unknown,
    metadata: unknown,
    vehicleCategory: unknown,
    processedUrls: string[],
    price: unknown,
  ) => Promise<void>;
  answerStaleCallback: (ctx: unknown) => Promise<void>;
}

// Records the stock ids the live catalog projection was asked to project. The
// projection itself is exercised by the CatalogProjectionService's own tests;
// here we only assert the Telegram commit fires it with the written stock id.
function makeProjection() {
  const projected: number[] = [];
  return {
    projected,
    projectStock: async (stockId: number) => {
      projected.push(stockId);
      return `part_stock_${stockId}`;
    },
  };
}

const metadata: ParseOutcome = {
  title: 'Магнитола для Nexia 3',
  description: 'Производство Корея, новая',
  brand: 'Chevrolet',
  models: ['Nexia 3'],
  vehicles: [{ brand: 'Chevrolet', model: 'Nexia 3' }],
  isUniversal: false,
  gm_number: '96234567',
  part_number_type: 'UNKNOWN',
  price: 450000,
  source: 'wizard',
  confidence: 1,
};

function draft(tgUserId: number, publicIds = ['mator/products/abc']) {
  return {
    sellerId: 7,
    tgUserId,
    metadata,
    title: metadata.title as string,
    // The wizard's explicit category choice, written verbatim on commit.
    vehicleCategory: PartVehicleCategory.ELECTRICAL_AND_LIGHTING,
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
    partModel: {
      upsert: upsert('partModel', {}),
      deleteMany: upsert('partModel.deleteMany', { count: 0 }),
    },
    stock: { upsert: upsert('stock', { id: 500 }) },
  };
}

function makeCtx(tgUserId?: number) {
  // `replies` captures every user-visible string, including a single-photo
  // success caption (which the bot sends via replyWithPhoto's caption arg).
  // `from.id` is set when provided so sendStepPrompt can re-arm the session TTL
  // (it reads ctx.from?.id) — the reopen/edit flows depend on this.
  const replies: string[] = [];
  return {
    replies,
    from: tgUserId === undefined ? undefined : { id: tgUserId },
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

function makeService(
  prisma: unknown,
  cloudinary: unknown,
  catalogProjection: unknown = makeProjection(),
): AnyService {
  // Bypass the constructor's Nest DI wiring — we only exercise the private
  // confirmation helpers, which depend on `prisma`, `cloudinary`,
  // `catalogProjection`, and `pending`.
  const svc = Object.create(TelegramService.prototype) as unknown as AnyService;
  Object.assign(svc, {
    logger: { log() {}, warn() {}, error() {}, debug() {} },
    prisma,
    cloudinary,
    catalogProjection,
    pending: new Map<number, unknown>(),
    // reopenFromPreview restores the rebuilt session here; the prototype-cast
    // bypasses the field initializer, so provide a real store.
    wizard: new WizardSessionStore(),
    // Sliding inactivity timers for wizard sessions (touchSession).
    sessionExpiry: new Map<number, NodeJS.Timeout>(),
    // answerStaleCallback dedupes the chat nudge per user via this map; the
    // prototype-cast bypasses the field initializer, so provide it here.
    staleNoticeSentAt: new Map<number, number>(),
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

    // The full write sequence ran (product first — vehicle links need its id).
    // partModel.deleteMany runs before the (brand, carModel, partModel) writes:
    // persistVehicleLinks now reconciles fitment (clear-then-recreate) so a
    // re-listed product never keeps stale vehicle links.
    expect(prisma.calls).toEqual([
      'product',
      'partModel.deleteMany',
      'brand',
      'carModel',
      'partModel',
      'productImage.deleteMany',
      'productImage.createMany',
      'stock',
    ]);
    // …and the session is consumed.
    expect(svc.pending.has(1)).toBe(false);
    // …and the success message is the simple confirmation (no product details).
    expect(ctx.replies.some((r) => r.includes('Товар успешно добавлен'))).toBe(
      true,
    );
    expect(ctx.replies.some((r) => r.includes('Название'))).toBe(false);
    expect(ctx.replies.some((r) => r.includes('OEM'))).toBe(false);
    expect(ctx.replies.some((r) => r.includes('Product ID'))).toBe(false);
  });

  it('commit projects the written stock into the buyer catalog (live read model)', async () => {
    const prisma = makePrisma();
    const projection = makeProjection();
    const svc = makeService(prisma, makeCloudinary(), projection);
    const ctx = makeCtx();
    svc.setPending(ctx, draft(1));

    await svc.commitPending(ctx, 1);

    // The just-upserted Stock (stub returns { id: 500 }) is projected exactly
    // once, so the CatalogPart exists immediately — no manual backfill needed.
    expect(projection.projected).toEqual([500]);
  });

  it('a catalog-projection failure does not fail the commit (best-effort)', async () => {
    const prisma = makePrisma();
    const failing = {
      projectStock: async () => {
        throw new Error('projection boom');
      },
    };
    const svc = makeService(prisma, makeCloudinary(), failing);
    const ctx = makeCtx();
    svc.setPending(ctx, draft(1));

    await svc.commitPending(ctx, 1);

    // Supply-side write already committed; the seller still sees success.
    expect(ctx.replies.some((r) => r.includes('Товар успешно добавлен'))).toBe(
      true,
    );
    expect(svc.pending.has(1)).toBe(false);
  });

  it('commit of a UNIVERSAL part clears vehicle links and creates none', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma, makeCloudinary());
    const ctx = makeCtx();
    const universal = {
      ...draft(1),
      metadata: {
        ...metadata,
        brand: null,
        models: [],
        vehicles: [],
        isUniversal: true,
      },
    };
    svc.setPending(ctx, universal);

    await svc.commitPending(ctx, 1);

    // No brand/carModel/partModel upserts — only the stale-row cleanup.
    expect(prisma.calls).toEqual([
      'product',
      'partModel.deleteMany',
      'productImage.deleteMany',
      'productImage.createMany',
      'stock',
    ]);
  });

  it('commit with nothing pending tells the user instead of writing', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma, makeCloudinary());
    const ctx = makeCtx();

    await svc.commitPending(ctx, 1);

    expect(prisma.calls).toEqual([]);
    expect(
      ctx.replies.some((r) => r.includes('Нет товара для подтверждения')),
    ).toBe(true);
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

describe('TelegramService — stale-catalog callback', () => {
  // A ctx that records the answerCbQuery text/options and any reply, plus the
  // keyboard-removal call answerStaleCallback makes. `from.id` is set so the
  // per-user nudge deduplication has a key to work with.
  function makeCallbackCtx(tgUserId = 1) {
    const cbAnswers: { text?: string; extra?: unknown }[] = [];
    const replies: string[] = [];
    let keyboardRemoved = false;
    return {
      from: { id: tgUserId },
      cbAnswers,
      replies,
      get keyboardRemoved() {
        return keyboardRemoved;
      },
      answerCbQuery: async (text?: string, extra?: unknown) => {
        cbAnswers.push({ text, extra });
        return true;
      },
      editMessageReplyMarkup: async () => {
        keyboardRemoved = true;
        return {} as unknown;
      },
      reply: async (text: string) => {
        replies.push(text);
        return {} as unknown;
      },
    };
  }

  it('answers a stale tap with an alert popup, strips the keyboard, and nudges', async () => {
    const svc = makeService(makePrisma(), makeCloudinary());
    const ctx = makeCallbackCtx();

    await svc.answerStaleCallback(ctx);

    // Popup shown with the "catalog updated" text as an alert (not a toast).
    expect(ctx.cbAnswers).toHaveLength(1);
    expect(ctx.cbAnswers[0].text).toContain('Каталог был обновлён');
    expect(ctx.cbAnswers[0].extra).toEqual({ show_alert: true });
    // Dead keyboard removed, and a follow-up nudge (with the /start prompt) sent.
    expect(ctx.keyboardRemoved).toBe(true);
    expect(ctx.replies.some((r) => r.includes('нажмите /start'))).toBe(true);
  });

  it('sends the chat nudge only ONCE for rapid repeat taps by the same user', async () => {
    const svc = makeService(makePrisma(), makeCloudinary());
    const ctx = makeCallbackCtx(42);

    // Three quick taps on (possibly different) stale buttons.
    await svc.answerStaleCallback(ctx);
    await svc.answerStaleCallback(ctx);
    await svc.answerStaleCallback(ctx);

    // The alert popup fires every time (Telegram renders it in place)…
    expect(ctx.cbAnswers).toHaveLength(3);
    // …but the chat message is deduplicated — no piled-up identical texts.
    expect(ctx.replies).toHaveLength(1);
  });

  it('deduplicates per user, not globally', async () => {
    const svc = makeService(makePrisma(), makeCloudinary());
    const a = makeCallbackCtx(1);
    const b = makeCallbackCtx(2);

    await svc.answerStaleCallback(a);
    await svc.answerStaleCallback(b); // different user — must still get a nudge

    expect(a.replies).toHaveLength(1);
    expect(b.replies).toHaveLength(1);
  });

  it('still nudges when answering the expired callback throws', async () => {
    const svc = makeService(makePrisma(), makeCloudinary());
    const ctx = {
      ...makeCallbackCtx(),
      answerCbQuery: async () => {
        throw new Error('query is too old');
      },
    };

    await svc.answerStaleCallback(ctx);

    // The throw is swallowed; the seller still gets the restart nudge.
    expect(ctx.replies.some((r) => r.includes('нажмите /start'))).toBe(true);
  });
});

describe('buildSessionFromPending', () => {
  it('reconstructs every wizard field from a pending draft', () => {
    const pending = { ...draft(1, ['id-a', 'id-b']), expiry: undefined };
    const session = buildSessionFromPending(pending as never);
    expect(session).toMatchObject({
      step: WizardStep.PRICE,
      brand: 'Chevrolet',
      model: 'Nexia 3',
      category: PartVehicleCategory.ELECTRICAL_AND_LIGHTING,
      title: 'Магнитола для Nexia 3',
      description: 'Производство Корея, новая',
      partNumberType: 'UNKNOWN',
      partNumber: '96234567',
      price: 450000,
    });
    // The processed photos are carried over (copied, not shared) for reuse.
    expect(session.processedUrls).toEqual([
      'https://cdn/img0.webp',
      'https://cdn/img1.webp',
    ]);
    expect(session.publicIds).toEqual(['id-a', 'id-b']);
    expect(session.publicIds).not.toBe(pending.publicIds); // defensive copy
  });
});

describe('TelegramService — reopen from preview', () => {
  // reopenFromPreview drives the wizard via sendStepPrompt → ctx.reply; makeCtx
  // captures those texts. No seller lookup happens on this path.
  it('"⬅️ Назад" (→ PRICE) restores the session and REUSES photos (no deletion)', async () => {
    const cloudinary = makeCloudinary();
    const svc = makeService(makePrisma(), cloudinary);
    const ctx = makeCtx();
    svc.setPending(ctx, draft(1, ['keep-1', 'keep-2']));

    await svc.reopenFromPreview(ctx, 1, WizardStep.PRICE);

    // Pending consumed, wizard session restored at PRICE with the photos intact.
    expect(svc.pending.has(1)).toBe(false);
    const session = svc.wizard.get(1);
    expect(session?.step).toBe(WizardStep.PRICE);
    expect(session?.publicIds).toEqual(['keep-1', 'keep-2']);
    expect(session?.processedUrls).toHaveLength(2);
    // Critically: NO Cloudinary assets were deleted — the photos are reused.
    expect(cloudinary.deleted).toEqual([]);
    // The seller is prompted for the PRICE step.
    expect(ctx.replies.some((r) => r.includes('цену'))).toBe(true);
  });

  it('"🖼 Изменить фото" (→ PHOTOS) deletes the old assets and clears them', async () => {
    const cloudinary = makeCloudinary();
    const svc = makeService(makePrisma(), cloudinary);
    const ctx = makeCtx();
    svc.setPending(ctx, draft(1, ['old-1', 'old-2']));

    await svc.reopenFromPreview(ctx, 1, WizardStep.PHOTOS);

    expect(svc.pending.has(1)).toBe(false);
    const session = svc.wizard.get(1);
    expect(session?.step).toBe(WizardStep.PHOTOS);
    // Photos are dropped from the session AND deleted from Cloudinary — the next
    // upload re-runs the pipeline.
    expect(session?.publicIds).toEqual([]);
    expect(session?.processedUrls).toEqual([]);
    expect(cloudinary.deleted).toEqual(['old-1', 'old-2']);
    // The seller is prompted to send photos.
    expect(ctx.replies.some((r) => r.includes('фото'))).toBe(true);
  });

  it('reports and no-ops when there is no pending draft to reopen', async () => {
    const cloudinary = makeCloudinary();
    const svc = makeService(makePrisma(), cloudinary);
    const ctx = makeCtx();

    await svc.reopenFromPreview(ctx, 1, WizardStep.PRICE);

    expect(svc.wizard.get(1)).toBeUndefined();
    expect(cloudinary.deleted).toEqual([]);
    expect(
      ctx.replies.some((r) => r.includes('Нет товара для редактирования')),
    ).toBe(true);
  });
});

describe('TelegramService — edit-loop scenarios', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  // Scenario 1: Preview → Назад → Price → Preview → Назад → Description →
  // Preview → Publish. Exactly ONE pending exists throughout, and commit writes
  // one product (upsert) — no duplicates, no orphan PendingProducts.
  it('multiple returns then publish → one pending at a time, one product written', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma, makeCloudinary());
    const ctx = makeCtx();
    svc.setPending(ctx, draft(1, ['keep-1'])); // first preview
    expect(svc.pending.size).toBe(1);

    // ── Round 1: ⬅️ Назад → edit → back to preview ──
    await svc.reopenFromPreview(ctx, 1, WizardStep.PRICE);
    expect(svc.pending.size).toBe(0); // pending consumed while editing
    const s1 = svc.wizard.get(1)!;
    await svc.finalizeToPreview(ctx, 1, s1, 7); // re-preview
    expect(svc.pending.size).toBe(1); // exactly one again

    // ── Round 2: ⬅️ Назад → edit → back to preview ──
    await svc.reopenFromPreview(ctx, 1, WizardStep.PRICE);
    expect(svc.pending.size).toBe(0);
    const s2 = svc.wizard.get(1)!;
    await svc.finalizeToPreview(ctx, 1, s2, 7);
    expect(svc.pending.size).toBe(1);

    // ── Publish ──
    await svc.commitPending(ctx, 1);
    expect(svc.pending.size).toBe(0);
    // product.upsert ran exactly once — one listing, never duplicated.
    expect(prisma.calls.filter((c) => c === 'product')).toHaveLength(1);
    expect(ctx.replies.some((r) => r.includes('Товар успешно добавлен'))).toBe(
      true,
    );
  });

  // Scenario 2: Preview → Изменить фото → new → Preview → Изменить фото → new →
  // Preview. After each replace, only the LATEST asset set survives in Cloudinary.
  it('repeated photo replacement keeps only the latest asset set', async () => {
    const cloudinary = makeCloudinary();
    const svc = makeService(makePrisma(), cloudinary);
    const ctx = makeCtx();

    // Preview #1 with asset set A.
    svc.setPending(ctx, draft(1, ['A']));

    // 🖼 Изменить фото → old A deleted; session awaits new photos.
    await svc.reopenFromPreview(ctx, 1, WizardStep.PHOTOS);
    expect(cloudinary.deleted).toEqual(['A']);
    // New photos B arrive → finalize builds a fresh preview from set B.
    const sB = svc.wizard.get(1)!;
    sB.processedUrls = ['https://cdn/B.webp'];
    sB.publicIds = ['B'];
    await svc.finalizeToPreview(ctx, 1, sB, 7);
    expect(svc.pending.get(1)).toBeDefined();

    // 🖼 Изменить фото again → old B deleted; new photos C.
    await svc.reopenFromPreview(ctx, 1, WizardStep.PHOTOS);
    expect(cloudinary.deleted).toEqual(['A', 'B']);
    const sC = svc.wizard.get(1)!;
    sC.processedUrls = ['https://cdn/C.webp'];
    sC.publicIds = ['C'];
    await svc.finalizeToPreview(ctx, 1, sC, 7);

    // Only C remains: A and B were both deleted, C was never deleted.
    expect(cloudinary.deleted).toEqual(['A', 'B']);
    const pendingC = svc.pending.get(1) as { publicIds: string[] };
    expect(pendingC.publicIds).toEqual(['C']);
  });

  // Scenario 3: Preview → ⬅️ Назад → Description → /start. The reopened session
  // (carrying photos) must be fully cleared and its images deleted.
  it('/start during an edit clears the session and deletes its photos', async () => {
    const cloudinary = makeCloudinary();
    const svc = makeService(makePrisma(), cloudinary);
    const ctx = makeCtx(1);
    svc.setPending(ctx, draft(1, ['img-1', 'img-2']));

    await svc.reopenFromPreview(ctx, 1, WizardStep.PRICE); // ⬅️ Назад
    // (seller walks in-wizard back to the DESCRIPTION step — photos stay on session)
    svc.wizard.get(1)!.step = WizardStep.DESCRIPTION;
    expect(svc.sessionExpiry.has(1)).toBe(true); // inactivity timer armed

    // /start calls discardSessionPhotos before restarting the wizard.
    await svc.discardSessionPhotos(1);

    // Images deleted, session removed, and the inactivity timer cancelled.
    expect(cloudinary.deleted).toEqual(['img-1', 'img-2']);
    expect(svc.sessionExpiry.has(1)).toBe(false);
    expect(svc.wizard.get(1)).toBeUndefined();
  });

  // Scenario 4: TTL. An abandoned edit session (carrying photos) must not live
  // forever — after the TTL its session and Cloudinary assets are cleaned up, and
  // a later reopen finds nothing to restore.
  it('an abandoned edit session expires: photos deleted, nothing to reopen', async () => {
    const cloudinary = makeCloudinary();
    const svc = makeService(makePrisma(), cloudinary);
    const ctx = makeCtx(1);
    svc.setPending(ctx, draft(1, ['ttl-1']));

    await svc.reopenFromPreview(ctx, 1, WizardStep.PRICE); // ⬅️ Назад, timer armed
    expect(svc.sessionExpiry.has(1)).toBe(true);
    expect(svc.wizard.get(1)).toBeDefined();

    // Seller abandons the edit; the TTL fires.
    jest.advanceTimersByTime(10 * 60 * 1000);
    await Promise.resolve(); // let the async cleanup settle

    // Session gone, its images deleted, timer forgotten.
    expect(svc.wizard.get(1)).toBeUndefined();
    expect(cloudinary.deleted).toEqual(['ttl-1']);
    expect(svc.sessionExpiry.has(1)).toBe(false);

    // A stale reopen (e.g. the seller taps ⬅️ Назад on the old preview) finds no
    // pending draft and cannot restore a non-existent session.
    const ctx2 = makeCtx(1);
    await svc.reopenFromPreview(ctx2, 1, WizardStep.PRICE);
    expect(svc.wizard.get(1)).toBeUndefined();
    expect(
      ctx2.replies.some((r) => r.includes('Нет товара для редактирования')),
    ).toBe(true);
  });

  // The pending confirmation's own TTL still works: an expired preview cannot be
  // published or reopened, and its assets are cleaned up.
  it('an expired pending cannot be reopened and its assets are cleaned', async () => {
    const cloudinary = makeCloudinary();
    const svc = makeService(makePrisma(), cloudinary);
    const ctx = makeCtx();
    svc.setPending(ctx, draft(1, ['exp-1']));

    jest.advanceTimersByTime(10 * 60 * 1000);
    await Promise.resolve();

    expect(svc.pending.has(1)).toBe(false);
    expect(cloudinary.deleted).toEqual(['exp-1']);

    // Reopen after expiry → nothing to restore.
    await svc.reopenFromPreview(ctx, 1, WizardStep.PRICE);
    expect(svc.wizard.get(1)).toBeUndefined();
    expect(
      ctx.replies.some((r) => r.includes('Нет товара для редактирования')),
    ).toBe(true);
  });
});

describe('TelegramService — wizard session inactivity TTL', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  const TTL = 10 * 60 * 1000;

  // A plain wizard session (no photos) expires and is dropped WITHOUT touching
  // Cloudinary.
  it('expires a photo-less session and never calls Cloudinary', async () => {
    const cloudinary = makeCloudinary();
    const svc = makeService(makePrisma(), cloudinary);
    const session = svc.wizard.start(1); // fresh session, no photos
    svc.touchSession(1); // arm the sliding timer (as /start does via sendStepPrompt)
    expect(session.publicIds).toEqual([]);

    jest.advanceTimersByTime(TTL);
    await Promise.resolve();

    // Session removed; NO Cloudinary deletion for a photo-less session.
    expect(svc.wizard.get(1)).toBeUndefined();
    expect(svc.sessionExpiry.has(1)).toBe(false);
    expect(cloudinary.deleted).toEqual([]);
  });

  // A session carrying processed photos deletes its Cloudinary assets on expiry.
  it('expires a session with photos and deletes its Cloudinary assets', async () => {
    const cloudinary = makeCloudinary();
    const svc = makeService(makePrisma(), cloudinary);
    const session = svc.wizard.start(1);
    session.processedUrls = ['https://cdn/a.webp', 'https://cdn/b.webp'];
    session.publicIds = ['pub-a', 'pub-b'];
    svc.touchSession(1);

    jest.advanceTimersByTime(TTL);
    await Promise.resolve();

    expect(svc.wizard.get(1)).toBeUndefined();
    expect(cloudinary.deleted).toEqual(['pub-a', 'pub-b']);
  });

  // Every user action re-arms the sliding timer, so activity before the deadline
  // keeps the session alive; only genuine inactivity past the window expires it.
  it('renews the TTL on each action (sliding window)', async () => {
    const cloudinary = makeCloudinary();
    const svc = makeService(makePrisma(), cloudinary);
    svc.wizard.start(1);
    svc.touchSession(1);

    // Just before expiry, the user acts → timer re-armed for another full window.
    jest.advanceTimersByTime(TTL - 1000);
    svc.touchSession(1); // an action (sendStepPrompt) renews it
    jest.advanceTimersByTime(TTL - 1000);
    // Total elapsed > TTL, but no single idle gap reached it → still alive.
    expect(svc.wizard.get(1)).toBeDefined();

    // Now go fully idle past the window → expires.
    jest.advanceTimersByTime(TTL);
    await Promise.resolve();
    expect(svc.wizard.get(1)).toBeUndefined();
  });

  // sendStepPrompt is the single arming point — driving it re-arms the timer for
  // the ctx's user, wiring the TTL to real wizard activity.
  it('sendStepPrompt arms/renews the session timer for ctx.from.id', async () => {
    const svc = makeService(makePrisma(), makeCloudinary());
    const session = svc.wizard.start(7);
    const ctx = makeCtx(7);

    await (
      svc as unknown as {
        sendStepPrompt: (c: unknown, s: unknown) => Promise<void>;
      }
    ).sendStepPrompt(ctx, session);

    expect(svc.sessionExpiry.has(7)).toBe(true);
  });
});

describe('TelegramService — preview caption', () => {
  it('includes the seller-chosen category (Russian label, not the enum)', async () => {
    const svc = makeService(makePrisma(), makeCloudinary());
    const ctx = makeCtx();

    await svc.sendPreview(
      ctx,
      metadata,
      PartVehicleCategory.SUSPENSION_AND_STEERING,
      ['https://cdn/img0.webp'], // single photo → caption captured by makeCtx
      new Decimal(450000),
    );

    const caption = ctx.replies.find((r) => r.includes('Категория'));
    expect(caption).toBeDefined();
    expect(caption).toContain('Ходовая и Рулевое'); // label, not the enum value
    expect(caption).not.toContain('SUSPENSION_AND_STEERING');
    // The full listing detail lines are still present.
    expect(caption).toContain('Название');
    expect(caption).toContain('Цена');
  });
});
