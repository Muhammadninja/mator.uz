// Focused tests for the confirmation-session state machine added to
// TelegramService: one pending product per user, replacement, expiry, and the
// commit/cancel behaviors (DB write happens only on commit).
//
// The bot itself is never launched here; we construct the service with stub
// dependencies and drive the private confirmation helpers directly.

import { PartVehicleCategory } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import type { ParseOutcome } from '../ai/part-parser.types';
import { buildSessionFromDraft, TelegramService } from './telegram.service';
import { WizardSessionStore, WizardStep } from './product-wizard';
import { makeFakeLock } from './draft-lock.test-util';

// Surface just the private members we drive in these tests. We build the
// instance from the prototype and cast through `unknown`, so this stands alone
// rather than intersecting TelegramService (whose private members would
// otherwise collapse the intersection to `never`).
interface AnyService {
  pending: Map<number, unknown>;
  wizard: WizardSessionStore;
  storePending: (draft: unknown) => boolean;
  discardPending: (tgUserId: number) => Promise<void>;
  commitPending: (ctx: unknown, tgUserId: number) => Promise<void>;
  cancelPendingDraft: (tgUserId: number) => Promise<void>;
  reopenDraftForEdit: (ctx: unknown, tgUserId: number) => Promise<void>;
  replaceDraftPhotos: (ctx: unknown, tgUserId: number) => Promise<void>;
  sendPreviewToChat: (
    chatId: number,
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
    // Every preview is backed by a draft (the source of truth).
    draftId: `draft_${tgUserId}`,
    draftVersion: 3,
  };
}

/** A READY_FOR_PREVIEW draft row as `drafts.findWithImages` would return it. */
function draftRow(over: Record<string, unknown> = {}) {
  return {
    id: 'draft_1',
    sellerId: 7,
    tgId: BigInt(1),
    status: 'READY_FOR_PREVIEW',
    version: 3,
    formStep: WizardStep.QUESTIONNAIRE_DONE,
    brand: 'Chevrolet',
    model: 'Nexia 3',
    category: PartVehicleCategory.ELECTRICAL_AND_LIGHTING,
    title: 'Магнитола для Nexia 3',
    description: 'Производство Корея, новая',
    partNumberType: 'UNKNOWN',
    partNumber: '96234567',
    priceUzs: new Decimal(450000),
    previewSentAt: new Date(),
    images: [
      { id: 'img_1', jobId: 'job_1', status: 'READY', sortOrder: 0 },
      { id: 'img_2', jobId: 'job_2', status: 'READY', sortOrder: 1 },
    ],
    ...over,
  };
}

/** ProductDraftService stub covering the draft-backed preview actions. */
function makeDrafts(over: Record<string, unknown> = {}) {
  return {
    findWithImages: jest.fn().mockResolvedValue(draftRow()),
    collectPublicIds: jest.fn().mockResolvedValue(['old-1', 'old-2']),
    collectOriginalPublicIds: jest.fn().mockResolvedValue(['orig-1']),
    reopenForEdit: jest.fn().mockResolvedValue(true),
    cloneForPhotoReplacement: jest.fn().mockResolvedValue({
      ...draftRow(),
      id: 'draft_new',
      status: 'CREATING',
    }),
    tryTransition: jest.fn().mockResolvedValue(true),
    publishDraft: jest.fn().mockResolvedValue(true),
    ...over,
  };
}

/**
 * QueueService stub. `enqueueImage`/`reenqueueImage` are stubbed even though the
 * preview-edit paths must NEVER call them: that way an accidental enqueue shows up
 * as a failed assertion (below) rather than as an unrelated "not a function" crash.
 */
function makeQueue() {
  return {
    removeImageJob: jest.fn().mockResolvedValue(undefined),
    enqueueImage: jest.fn().mockResolvedValue({ id: 'job_x' }),
    reenqueueImage: jest.fn().mockResolvedValue({ id: 'job_x' }),
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
  over: Record<string, unknown> = {},
): AnyService {
  // Bypass the constructor's Nest DI wiring — we only exercise the private
  // confirmation helpers, which depend on `prisma`, `cloudinary`,
  // `catalogProjection`, `drafts`, `queue` and `pending`.
  const svc = Object.create(TelegramService.prototype) as unknown as AnyService;
  Object.assign(svc, {
    logger: { log() {}, warn() {}, error() {}, debug() {} },
    prisma,
    cloudinary,
    catalogProjection,
    pending: new Map<number, unknown>(),
    // The draft-backed preview actions (edit / replace-photos / cancel).
    drafts: makeDrafts(),
    queue: makeQueue(),
    telemetry: { event: jest.fn(), metric: jest.fn() },
    // Real in-memory mutex for the clone / reopen guards (see draft-lock.test-util).
    locks: makeFakeLock(),
    draftTtlMs: 24 * 60 * 60 * 1000,
    // The edit paths restore the rebuilt session here; the prototype-cast
    // bypasses the field initializer, so provide a real store.
    wizard: new WizardSessionStore(),
    // answerStaleCallback dedupes the chat nudge per user via this map; the
    // prototype-cast bypasses the field initializer, so provide it here.
    staleNoticeSentAt: new Map<number, number>(),
    ...over,
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
    svc.storePending(draft(1));
    expect(svc.pending.has(1)).toBe(true);
    expect(svc.pending.size).toBe(1);
  });

  it('replaces an existing pending product, reporting the replacement', () => {
    const cloudinary = makeCloudinary();
    const svc = makeService(makePrisma(), cloudinary);
    expect(svc.storePending(draft(1, ['old-1']))).toBe(false); // nothing replaced
    expect(svc.storePending(draft(1, ['new-1']))).toBe(true); // replaced
    expect(svc.pending.size).toBe(1);
    // The superseded preview's assets are deleted; the new ones are kept.
    expect(cloudinary.deleted).toEqual(['old-1']);
  });

  it('the pending TTL drops only the in-memory cache — assets survive for /start recovery', () => {
    const cloudinary = makeCloudinary();
    const svc = makeService(makePrisma(), cloudinary);
    svc.storePending(draft(1, ['keep-me']));
    expect(svc.pending.has(1)).toBe(true);

    jest.advanceTimersByTime(10 * 60 * 1000); // 10 minutes

    expect(svc.pending.has(1)).toBe(false);
    // Critically: the draft is still READY_FOR_PREVIEW and /start re-presents it
    // with these exact processed URLs, so they must NOT have been deleted.
    expect(cloudinary.deleted).toEqual([]);
  });

  it('commit writes the product to the DB and clears the pending session', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma, makeCloudinary());
    const ctx = makeCtx();
    svc.storePending(draft(1));

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
    svc.storePending(draft(1));

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
    svc.storePending(draft(1));

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
    svc.storePending(universal);

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
    svc.storePending(draft(1));

    await svc.commitPending(ctx, 1);
    const afterFirst = prisma.calls.length;
    await svc.commitPending(ctx, 1); // second tap — nothing pending now

    expect(prisma.calls.length).toBe(afterFirst); // no additional writes
  });

  // ── Cloudinary asset cleanup ────────────────────────────────────────────────
  it('cancel deletes the preview assets and CANCELS the backing draft (no DB product write)', async () => {
    const prisma = makePrisma();
    const cloudinary = makeCloudinary();
    const drafts = makeDrafts();
    const svc = makeService(prisma, cloudinary, makeProjection(), { drafts });
    svc.storePending(draft(1, ['id-a', 'id-b']));

    await svc.cancelPendingDraft(1); // what the ❌ handler calls

    expect(svc.pending.has(1)).toBe(false);
    // Processed assets (from the pending record) AND the stored originals.
    expect(cloudinary.deleted).toEqual(['id-a', 'id-b', 'orig-1']);
    // The draft is moved to a terminal state so the TTL sweep has nothing to do.
    expect(drafts.tryTransition).toHaveBeenCalledWith(
      'draft_1',
      'READY_FOR_PREVIEW',
      'CANCELLED',
      3,
    );
    expect(prisma.calls).toEqual([]); // nothing written
  });

  it('cancel is a no-op when there is nothing pending', async () => {
    const cloudinary = makeCloudinary();
    const drafts = makeDrafts();
    const svc = makeService(makePrisma(), cloudinary, makeProjection(), {
      drafts,
    });

    await svc.cancelPendingDraft(1);

    expect(cloudinary.deleted).toEqual([]);
    expect(drafts.tryTransition).not.toHaveBeenCalled();
  });

  it('replacement deletes the OLD pending assets (keeps the new ones)', async () => {
    const cloudinary = makeCloudinary();
    const svc = makeService(makePrisma(), cloudinary);
    svc.storePending(draft(1, ['old-1', 'old-2']));
    svc.storePending(draft(1, ['new-1']));
    await Promise.resolve();

    expect(cloudinary.deleted).toEqual(['old-1', 'old-2']); // only the old ones
    expect(svc.pending.size).toBe(1); // the new draft is retained
  });

  it('successful confirmation KEEPS the processed assets and publishes the draft', async () => {
    const cloudinary = makeCloudinary();
    const drafts = makeDrafts();
    const svc = makeService(makePrisma(), cloudinary, makeProjection(), {
      drafts,
    });
    const ctx = makeCtx();
    svc.storePending(draft(1, ['keep-1', 'keep-2']));

    await svc.commitPending(ctx, 1);

    // The product's images (the processed assets) are NEVER deleted…
    expect(cloudinary.deleted).not.toContain('keep-1');
    expect(cloudinary.deleted).not.toContain('keep-2');
    // …only the intermediate stored ORIGINALS, which nothing references any more.
    expect(cloudinary.deleted).toEqual(['orig-1']);
    // The draft is PUBLISHED so the TTL sweep can never touch it.
    expect(drafts.publishDraft).toHaveBeenCalledWith('draft_1');
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

describe('buildSessionFromDraft', () => {
  it('reconstructs every wizard field from the draft, positioned at the given step', () => {
    const session = buildSessionFromDraft(
      draftRow() as never,
      WizardStep.PRICE,
    );
    expect(session).toEqual({
      step: WizardStep.PRICE,
      draftId: 'draft_1',
      brand: 'Chevrolet',
      model: 'Nexia 3',
      category: PartVehicleCategory.ELECTRICAL_AND_LIGHTING,
      title: 'Магнитола для Nexia 3',
      description: 'Производство Корея, новая',
      partNumberType: 'UNKNOWN',
      partNumber: '96234567',
      price: 450000,
    });
    // The session carries NO image state — the draft's rows own that.
    expect(session).not.toHaveProperty('processedUrls');
    expect(session).not.toHaveProperty('publicIds');
  });

  it('tolerates an unfilled draft (fresh clone at PHOTOS_FIRST)', () => {
    const session = buildSessionFromDraft(
      draftRow({
        brand: null,
        model: null,
        category: null,
        title: null,
        description: null,
        partNumber: null,
        priceUzs: null,
      }) as never,
      WizardStep.PHOTOS_FIRST,
    );
    expect(session.step).toBe(WizardStep.PHOTOS_FIRST);
    expect(session.price).toBeNull();
    expect(session.partNumberType).toBe('UNKNOWN');
  });
});

describe('TelegramService — "⬅️ Назад" (draft-backed text/price edit)', () => {
  it('reopens the draft to CREATING at PRICE and REUSES the photos (no deletion, no re-processing)', async () => {
    const cloudinary = makeCloudinary();
    const drafts = makeDrafts();
    const queue = makeQueue();
    const svc = makeService(makePrisma(), cloudinary, makeProjection(), {
      drafts,
      queue,
    });
    const ctx = makeCtx(1);
    svc.storePending(draft(1, ['keep-1', 'keep-2']));

    await svc.reopenDraftForEdit(ctx, 1);

    // The draft moved back to CREATING under the optimistic lock, at PRICE.
    expect(drafts.reopenForEdit).toHaveBeenCalledWith(
      'draft_1',
      3,
      WizardStep.PRICE,
    );
    // Pending consumed; the dialogue is restored at PRICE from the DRAFT.
    expect(svc.pending.has(1)).toBe(false);
    const session = svc.wizard.get(1);
    expect(session?.step).toBe(WizardStep.PRICE);
    expect(session?.draftId).toBe('draft_1');
    expect(session?.title).toBe('Магнитола для Nexia 3');
    // Critically: NO assets deleted and the QUEUE IS NOT INVOLVED AT ALL — the
    // images are already READY, so editing text/price must never enqueue, re-enqueue
    // or remove a single image job.
    expect(cloudinary.deleted).toEqual([]);
    expect(queue.enqueueImage).not.toHaveBeenCalled();
    expect(queue.reenqueueImage).not.toHaveBeenCalled();
    expect(queue.removeImageJob).not.toHaveBeenCalled();
    expect(ctx.replies.some((r) => r.includes('цену'))).toBe(true);
  });

  it('reports and no-ops when there is no pending record to reopen', async () => {
    const cloudinary = makeCloudinary();
    const drafts = makeDrafts();
    const svc = makeService(makePrisma(), cloudinary, makeProjection(), {
      drafts,
    });
    const ctx = makeCtx(1);

    await svc.reopenDraftForEdit(ctx, 1);

    expect(svc.wizard.get(1)).toBeUndefined();
    expect(drafts.reopenForEdit).not.toHaveBeenCalled();
    expect(
      ctx.replies.some((r) => r.includes('Нет товара для редактирования')),
    ).toBe(true);
  });

  it('reports when the draft moved on (lost the optimistic lock / double-tap)', async () => {
    const drafts = makeDrafts({
      reopenForEdit: jest.fn().mockResolvedValue(false),
    });
    const svc = makeService(makePrisma(), makeCloudinary(), makeProjection(), {
      drafts,
    });
    const ctx = makeCtx(1);
    svc.storePending(draft(1));

    await svc.reopenDraftForEdit(ctx, 1);

    expect(svc.wizard.get(1)).toBeUndefined();
    expect(ctx.replies.some((r) => r.includes('больше нельзя изменить'))).toBe(
      true,
    );
  });
});

describe('TelegramService — "🖼 Изменить фото" (clone → PHOTOS_FIRST via the queue)', () => {
  it('cancels the source, clones its form fields, drops its assets/jobs, and asks for new photos', async () => {
    const cloudinary = makeCloudinary();
    const drafts = makeDrafts();
    const queue = makeQueue();
    const svc = makeService(makePrisma(), cloudinary, makeProjection(), {
      drafts,
      queue,
    });
    const ctx = makeCtx(1);
    svc.storePending(draft(1, ['old-1', 'old-2']));

    await svc.replaceDraftPhotos(ctx, 1);

    // A NEW draft was created from the source (source → CANCELLED inside the clone).
    expect(drafts.cloneForPhotoReplacement).toHaveBeenCalledWith({
      sourceId: 'draft_1',
      expectedStatus: 'READY_FOR_PREVIEW',
      expiresAt: expect.any(Date),
      formStep: WizardStep.PHOTOS_FIRST,
    });
    // The old draft's assets are deleted and its leftover jobs removed.
    expect(cloudinary.deleted).toEqual(['old-1', 'old-2']);
    expect(queue.removeImageJob).toHaveBeenCalledWith('job_1');
    expect(queue.removeImageJob).toHaveBeenCalledWith('job_2');
    // The dialogue now sits on the CLONE at PHOTOS_FIRST, form data carried over.
    const session = svc.wizard.get(1);
    expect(session?.step).toBe(WizardStep.PHOTOS_FIRST);
    expect(session?.draftId).toBe('draft_new');
    expect(session?.title).toBe('Магнитола для Nexia 3');
    expect(session?.price).toBe(450000);
    expect(svc.pending.has(1)).toBe(false);
    // The seller is told their data is kept and asked for new photos.
    expect(ctx.replies.some((r) => r.includes('новые фотографии'))).toBe(true);
  });

  it('deletes the old assets and jobs strictly AFTER the clone commits', async () => {
    // Ordering guard: the clone (create new + cancel old, one transaction) must
    // COMMIT before anything destructive happens. If assets were deleted first and
    // the clone then failed, the seller would keep a preview pointing at dead images.
    const order: string[] = [];
    const cloudinary = {
      deleted: [] as string[],
      deleteAssets: async (ids: string[]) => {
        order.push('deleteAssets');
        cloudinary.deleted.push(...ids);
      },
    };
    const queue = {
      removeImageJob: jest.fn().mockImplementation(async () => {
        order.push('removeImageJob');
      }),
      enqueueImage: jest.fn(),
      reenqueueImage: jest.fn(),
    };
    const drafts = makeDrafts({
      collectPublicIds: jest.fn().mockImplementation(async () => {
        // Read BEFORE the clone (the rows go terminal with the source).
        order.push('collectPublicIds');
        return ['old-1'];
      }),
      cloneForPhotoReplacement: jest.fn().mockImplementation(async () => {
        order.push('clone');
        return { ...draftRow(), id: 'draft_new', status: 'CREATING' };
      }),
    });
    const svc = makeService(makePrisma(), cloudinary, makeProjection(), {
      drafts,
      queue,
    });
    svc.storePending(draft(1, ['old-1']));

    await svc.replaceDraftPhotos(makeCtx(1), 1);

    // Ids are collected first (the source is about to become terminal), the clone
    // commits next, and only then are jobs/assets discarded.
    expect(order).toEqual([
      'collectPublicIds',
      'clone',
      'removeImageJob',
      'removeImageJob',
      'deleteAssets',
    ]);
  });

  it('leaves everything untouched when the clone loses the race', async () => {
    const cloudinary = makeCloudinary();
    const queue = makeQueue();
    const drafts = makeDrafts({
      cloneForPhotoReplacement: jest.fn().mockResolvedValue(null),
    });
    const svc = makeService(makePrisma(), cloudinary, makeProjection(), {
      drafts,
      queue,
    });
    const ctx = makeCtx(1);
    svc.storePending(draft(1, ['old-1']));

    await svc.replaceDraftPhotos(ctx, 1);

    // Nothing destructive ran — the source draft keeps its assets and jobs.
    expect(cloudinary.deleted).toEqual([]);
    expect(queue.removeImageJob).not.toHaveBeenCalled();
    expect(svc.wizard.get(1)).toBeUndefined();
    expect(ctx.replies.some((r) => r.includes('больше нельзя изменить'))).toBe(
      true,
    );
  });

  it('refuses when the source draft is no longer READY_FOR_PREVIEW', async () => {
    const drafts = makeDrafts({
      findWithImages: jest
        .fn()
        .mockResolvedValue(draftRow({ status: 'PUBLISHED' })),
    });
    const cloudinary = makeCloudinary();
    const svc = makeService(makePrisma(), cloudinary, makeProjection(), {
      drafts,
    });
    const ctx = makeCtx(1);
    svc.storePending(draft(1, ['published-1']));

    await svc.replaceDraftPhotos(ctx, 1);

    expect(drafts.cloneForPhotoReplacement).not.toHaveBeenCalled();
    expect(cloudinary.deleted).toEqual([]); // a published product keeps its images
    expect(ctx.replies.some((r) => r.includes('больше нельзя изменить'))).toBe(
      true,
    );
  });
});

describe('TelegramService — preview caption', () => {
  it('includes the seller-chosen category (Russian label, not the enum)', async () => {
    const sent: { chatId: number; caption?: string }[] = [];
    const svc = makeService(makePrisma(), makeCloudinary(), makeProjection(), {
      bot: {
        telegram: {
          sendPhoto: async (
            chatId: number,
            _media: unknown,
            extra?: { caption?: string },
          ) => {
            sent.push({ chatId, caption: extra?.caption });
            return {} as unknown;
          },
          sendMediaGroup: async () => ({}) as unknown,
          sendMessage: async (chatId: number, text: string) => {
            sent.push({ chatId, caption: text });
            return {} as unknown;
          },
        },
      },
    });

    await svc.sendPreviewToChat(
      1,
      metadata,
      PartVehicleCategory.SUSPENSION_AND_STEERING,
      ['https://cdn/img0.webp'], // single photo → caption on sendPhoto
      new Decimal(450000),
    );

    const caption = sent.find((s) => s.caption?.includes('Категория'))?.caption;
    expect(caption).toBeDefined();
    expect(caption).toContain('Ходовая и Рулевое'); // label, not the enum value
    expect(caption).not.toContain('SUSPENSION_AND_STEERING');
    // The full listing detail lines are still present.
    expect(caption).toContain('Название');
    expect(caption).toContain('Цена');
  });
});
