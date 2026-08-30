// Focused tests for the confirmation-session state machine added to
// TelegramService: one pending product per user, replacement, expiry, and the
// commit/cancel behaviors (DB write happens only on commit).
//
// The bot itself is never launched here; we construct the service with stub
// dependencies and drive the private confirmation helpers directly.

import {
  OilType,
  PartMainCategory,
  PartVehicleCategory,
  ProductKind,
} from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import type { ParseOutcome } from '../ai/part-parser.types';
import {
  buildSessionFromDraft,
  isDraftComplete,
  SELLER_APPROVED_MESSAGE,
  TelegramService,
} from './telegram.service';
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
    listing: unknown,
    processedUrls: string[],
  ) => Promise<void>;
  /** The preview caption + keyboard builder — the last hop before the seller
   *  reads the confirmation message. */
  buildPreview: (listing: unknown) => { caption: string };
  answerStaleCallback: (ctx: unknown) => Promise<void>;
  onSellerApproved: (event: {
    sellerId: number;
    tgId: bigint;
  }) => Promise<void>;
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

function draft(
  tgUserId: number,
  publicIds = ['mator/products/abc'],
  over: Record<string, unknown> = {},
) {
  return {
    sellerId: 7,
    tgUserId,
    metadata,
    kind: ProductKind.SPARE_PART,
    title: metadata.title as string,
    // The wizard's explicit category choice, written verbatim on commit.
    vehicleCategory: PartVehicleCategory.ELECTRICAL_AND_LIGHTING,
    // The subcategory picked under it — a SEPARATE column, not a replacement.
    subcategory: PartMainCategory.LIGHTING,
    oilViscosity: null,
    oilType: null,
    oilVolumeMl: null,
    antifreezeWeightG: null,
    processedUrls: publicIds.map((_, i) => `https://cdn/img${i}.webp`),
    publicIds,
    price: new Decimal(450000),
    // Every preview is backed by a draft (the source of truth).
    draftId: `draft_${tgUserId}`,
    draftVersion: 3,
    ...over,
  };
}

/**
 * A pending MOTOR_OIL confirmation, shaped exactly as `buildPendingFromDraft`
 * derives one from an oil draft: no vehicle, no part number, and metadata whose
 * `isUniversal` is already true because the kind — not a question — decides it.
 */
function oilPending(tgUserId: number) {
  return draft(tgUserId, ['mator/products/oil'], {
    kind: ProductKind.MOTOR_OIL,
    vehicleCategory: null,
    oilViscosity: '5W-30',
    oilType: OilType.SYNTHETIC,
    oilVolumeMl: 4_000,
    title: 'Mobil 1 ESP 5W-30 4L',
    metadata: {
      ...metadata,
      title: 'Mobil 1 ESP 5W-30 4L',
      brand: null,
      models: [],
      vehicles: [],
      gm_number: null,
      isUniversal: true,
    },
  });
}

/**
 * A pending ANTIFREEZE confirmation, shaped as `buildPendingFromDraft` derives
 * one: no vehicle, no part number, no oil attribute — just the packaged weight
 * in GRAMS, which is the kind's single attribute.
 */
function antifreezePending(tgUserId: number, weightG: number | null = 10_000) {
  return draft(tgUserId, ['mator/products/antifreeze'], {
    kind: ProductKind.ANTIFREEZE,
    vehicleCategory: null,
    antifreezeWeightG: weightG,
    title: 'Antifriz G12 10kg',
    metadata: {
      ...metadata,
      title: 'Antifriz G12 10kg',
      brand: null,
      models: [],
      vehicles: [],
      gm_number: null,
      isUniversal: true,
    },
  });
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
    kind: 'SPARE_PART',
    brand: 'Chevrolet',
    model: 'Nexia 3',
    category: PartVehicleCategory.ELECTRICAL_AND_LIGHTING,
    // The dynamic tree ids that back the legacy enum above. `categoryId` is what
    // completeness now requires (an admin-created category has no enum mirror).
    vehicleCategoryId: 'electrical-and-lighting',
    categoryId: 'electrical-parts',
    title: 'Магнитола для Nexia 3',
    description: 'Производство Корея, новая',
    partNumberType: 'UNKNOWN',
    partNumber: '96234567',
    oilViscosity: null,
    oilType: null,
    oilVolumeMl: null,
    // The sale form: unanswered, i.e. this category offered a single package
    // code and the seller was never asked.
    packageForm: null,
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
    // The DB fallback used when the in-memory `pending` record is missing. Default
    // to "no draft awaiting a preview" so the no-pending tests below assert the
    // genuinely empty case; tests exercising the fallback override it.
    findAwaitingPreview: jest.fn().mockResolvedValue(null),
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
// `calls` keeps the ORDER of the writes; `args` keeps the last payload per write
// name, for assertions about what was actually persisted.
function makePrisma() {
  const calls: string[] = [];
  const args: Record<string, unknown> = {};
  const upsert =
    (name: string, ret: unknown) =>
    async (arg?: unknown) => {
      calls.push(name);
      args[name] = arg;
      return ret;
    };
  return {
    calls,
    args,
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
    // Needed by the DB fallback that runs when the `pending` cache misses: the
    // preview actions resolve the seller, then look up their awaiting-preview draft.
    sellers: {
      findByTgId: jest.fn().mockResolvedValue({ id: 1, status: 'ACTIVE' }),
    },
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
    // The interface-language read cache; the prototype-cast bypasses the field
    // initializer, so provide a real Map (an empty one falls back to the DB,
    // which the `sellers` stub below answers).
    langCache: new Map<number, 'ru' | 'uz' | 'en'>(),
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

  it('a MOTOR_OIL commit stores the product as UNIVERSAL and creates NO compatibility rows', async () => {
    // Motor oils fit every vehicle by design: isUniversal is derived from the
    // kind with no seller interaction, and no vehicle link is ever written.
    const prisma = makePrisma();
    const svc = makeService(prisma, makeCloudinary());
    const ctx = makeCtx();
    svc.storePending(oilPending(1));

    await svc.commitPending(ctx, 1);

    const upsert = prisma.args['product'] as {
      create: { isUniversal: boolean; kind: string };
      update: { isUniversal: boolean; kind: string };
    };
    // Universal on BOTH branches, so a re-listing converges on it too.
    expect(upsert.create.isUniversal).toBe(true);
    expect(upsert.update.isUniversal).toBe(true);
    expect(upsert.create.kind).toBe(ProductKind.MOTOR_OIL);

    // The fitment reconcile still runs (it clears anything stale), but NOTHING is
    // recreated: no brand, no car model, no part_models row.
    expect(prisma.calls).toContain('partModel.deleteMany');
    expect(prisma.calls).not.toContain('partModel');
    expect(prisma.calls).not.toContain('brand');
    expect(prisma.calls).not.toContain('carModel');
  });

  it('stores the main category AND the subcategory in their own columns', async () => {
    // The two levels are SEPARATE columns and neither replaces the other:
    //   vehicleCategory ← the vehicle-selected main category (BRAKE_SYSTEM)
    //   mainCategory    ← the subcategory picked under it (BRAKES)
    // The column NAMES are the confusing part (Product.mainCategory holds a
    // PartMainCategory, which is the SUB level of this hierarchy), so this test
    // pins the stored VALUES rather than trusting the names.
    const prisma = makePrisma();
    const svc = makeService(prisma, makeCloudinary());
    svc.storePending(
      draft(1, ['a'], {
        vehicleCategory: PartVehicleCategory.BRAKE_SYSTEM,
        subcategory: PartMainCategory.BRAKES,
      }),
    );

    await svc.commitPending(makeCtx(), 1);

    const upsert = prisma.args['product'] as {
      create: { mainCategory: string; vehicleCategory: string };
      update: { mainCategory: string; vehicleCategory: string };
    };
    // The main category survives the commit untouched — NOT overwritten by the
    // subcategory (the regression this test exists to catch).
    expect(upsert.create.vehicleCategory).toBe(
      PartVehicleCategory.BRAKE_SYSTEM,
    );
    expect(upsert.create.mainCategory).toBe(PartMainCategory.BRAKES);
    // Same on the update branch, so a re-listing converges on both values.
    expect(upsert.update.vehicleCategory).toBe(
      PartVehicleCategory.BRAKE_SYSTEM,
    );
    expect(upsert.update.mainCategory).toBe(PartMainCategory.BRAKES);
  });

  it('a category with no subcategory keeps its main category and classifies the rest', async () => {
    // TRANSMISSION asks no subcategory, so `subcategory` is null and the
    // classifier's guess still fills mainCategory — unchanged from before.
    const prisma = makePrisma();
    const svc = makeService(prisma, makeCloudinary());
    svc.storePending(
      draft(1, ['a'], {
        vehicleCategory: PartVehicleCategory.TRANSMISSION,
        subcategory: null,
      }),
    );

    await svc.commitPending(makeCtx(), 1);

    const upsert = prisma.args['product'] as {
      create: { mainCategory: string; vehicleCategory: string };
    };
    expect(upsert.create.vehicleCategory).toBe(PartVehicleCategory.TRANSMISSION);
    // Still populated (by the classifier), never null-ed out by the new step.
    expect(Object.values(PartMainCategory)).toContain(
      upsert.create.mainCategory,
    );
  });

  it('a spare-part commit is still NOT universal and still writes its vehicle links', async () => {
    // Regression guard: making oils universal must not universalize spare parts.
    const prisma = makePrisma();
    const svc = makeService(prisma, makeCloudinary());
    svc.storePending(draft(1));

    await svc.commitPending(makeCtx(), 1);

    const upsert = prisma.args['product'] as {
      create: { isUniversal: boolean; kind: string };
    };
    expect(upsert.create.isUniversal).toBe(false);
    expect(upsert.create.kind).toBe(ProductKind.SPARE_PART);
    expect(prisma.calls).toContain('partModel');
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

describe('isDraftComplete (per-kind completeness)', () => {
  /** The oil equivalent of `draftRow` — no vehicle, no part number. */
  const oilDraft = (over: Record<string, unknown> = {}) =>
    draftRow({
      kind: ProductKind.MOTOR_OIL,
      brand: null,
      model: null,
      category: null,
      // An oil's taxonomy follows from its KIND, so it carries no category at
      // all — neither the legacy enum nor a tree id — and must still complete.
      vehicleCategoryId: null,
      categoryId: null,
      partNumber: null,
      oilViscosity: '5W-30',
      oilType: OilType.SYNTHETIC,
      oilVolumeMl: 4_000,
      ...over,
    }) as never;

  it('accepts a filled spare part', () => {
    expect(isDraftComplete(draftRow() as never)).toBe(true);
  });

  it('accepts an oil that has NO vehicle — the flow never asks for one', () => {
    expect(isDraftComplete(oilDraft())).toBe(true);
  });

  it('rejects a spare part missing its vehicle or category', () => {
    expect(isDraftComplete(draftRow({ brand: null }) as never)).toBe(false);
    expect(isDraftComplete(draftRow({ model: null }) as never)).toBe(false);
    // `categoryId` — the dynamic tree node — is the requirement now.
    expect(isDraftComplete(draftRow({ categoryId: null }) as never)).toBe(false);
  });

  it('accepts a spare part in an admin-created category with no enum mirror', () => {
    // The point of the dynamic tree: a category the admin invented has no
    // PartVehicleCategory/PartMainCategory value, and must still be complete.
    expect(
      isDraftComplete(
        draftRow({
          category: null,
          vehicleCategoryId: 'brake-system',
          categoryId: 'custom-brake-pads',
        }) as never,
      ),
    ).toBe(true);
  });

  it('accepts a spare part whose category is a LEAF root (no subcategory step)', () => {
    // A root with no children answers the question by itself, so categoryId ==
    // vehicleCategoryId and no further selection was ever asked for.
    expect(
      isDraftComplete(
        draftRow({
          vehicleCategoryId: 'transmission',
          categoryId: 'transmission',
        }) as never,
      ),
    ).toBe(true);
  });

  it('rejects an oil missing any of its own attributes', () => {
    expect(isDraftComplete(oilDraft({ oilViscosity: null }))).toBe(false);
    expect(isDraftComplete(oilDraft({ oilType: null }))).toBe(false);
    expect(isDraftComplete(oilDraft({ oilVolumeMl: null }))).toBe(false);
  });

  it('accepts an antifreeze with only its weight, and rejects it without', () => {
    // ANTIFREEZE requires exactly ONE attribute — no viscosity, no volume, no
    // vehicle, no category question — so a draft carrying just the weight (plus
    // the universal title/price) is complete.
    const antifreeze = (over: Record<string, unknown> = {}) =>
      draftRow({
        kind: ProductKind.ANTIFREEZE,
        brand: null,
        model: null,
        category: null,
        categoryId: 'antifreeze',
        vehicleCategoryId: 'maintenance-and-fluids',
        antifreezeWeightG: 2_500,
        ...over,
      }) as never;
    expect(isDraftComplete(antifreeze())).toBe(true);
    expect(isDraftComplete(antifreeze({ antifreezeWeightG: null }))).toBe(false);
  });

  it('requires title and price from every kind', () => {
    expect(isDraftComplete(draftRow({ title: null }) as never)).toBe(false);
    expect(isDraftComplete(draftRow({ priceUzs: null }) as never)).toBe(false);
    expect(isDraftComplete(oilDraft({ title: null }))).toBe(false);
    expect(isDraftComplete(oilDraft({ priceUzs: null }))).toBe(false);
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
      // No language was passed, so the dialogue is rebuilt in the default one.
      lang: 'ru',
      kind: ProductKind.SPARE_PART,
      brand: 'Chevrolet',
      model: 'Nexia 3',
      category: PartVehicleCategory.ELECTRICAL_AND_LIGHTING,
      // draftRow() carries no `subcategory` key, so the rebuilt session mirrors
      // that as undefined rather than inventing a value.
      subcategory: undefined,
      // The dynamic category ids are restored verbatim from the draft…
      vehicleCategoryId: 'electrical-and-lighting',
      categoryId: 'electrical-parts',
      // …but the OPTION list is not: it is re-loaded from the live tree whenever
      // a category step is re-rendered, so a resumed session never replays a
      // stale snapshot of a taxonomy the admin may have changed meanwhile.
      categoryOptions: [],
      // Nor WHICH level was last offered — that is re-derived from the step the
      // resumed dialogue is standing on.
      categoryOptionsParentId: null,
      categoryStepPending: false,
      // Re-loaded from the live tree when OIL_TYPE is next rendered, never
      // restored from the draft (see buildSessionFromDraft).
      transmissionOption: null,
      // No sale form was answered, so the question is not on this dialogue's
      // path either — the category's single package code applies.
      packageForm: null,
      packageChoiceRequired: false,
      title: 'Магнитола для Nexia 3',
      description: 'Производство Корея, новая',
      partNumberType: 'UNKNOWN',
      partNumber: '96234567',
      // A spare part carries no oil attributes, and neither "Другое" free-text
      // branch was taken (both are derived from the stored values).
      oilViscosity: null,
      oilType: null,
      oilVolumeMl: null,
      viscosityIsCustom: false,
      volumeIsCustom: false,
      // Nor any antifreeze attribute: draftRow() is a spare part.
      antifreezeWeightG: undefined,
      weightIsCustom: false,
      price: 450000,
    });
    // The session carries NO image state — the draft's rows own that.
    expect(session).not.toHaveProperty('processedUrls');
    expect(session).not.toHaveProperty('publicIds');
  });

  it('restores an oil draft with its kind and attributes', () => {
    const session = buildSessionFromDraft(
      draftRow({
        kind: ProductKind.MOTOR_OIL,
        brand: null,
        model: null,
        category: null,
        oilViscosity: '5W-30',
        oilType: OilType.SYNTHETIC,
        oilVolumeMl: 4_000,
      }) as never,
      WizardStep.PRICE,
    );
    expect(session).toMatchObject({
      kind: ProductKind.MOTOR_OIL,
      oilViscosity: '5W-30',
      oilType: OilType.SYNTHETIC,
      oilVolumeMl: 4_000,
      // Both values are presets, so neither "Другое" branch is on the path.
      viscosityIsCustom: false,
      volumeIsCustom: false,
    });
  });

  it('re-derives the "Другое" branches from non-preset stored values', () => {
    // A resumed draft must walk BACK the same way it walked forward, even though
    // the free-text detours are not persisted — they are recomputed here.
    const session = buildSessionFromDraft(
      draftRow({
        kind: ProductKind.MOTOR_OIL,
        oilViscosity: '0W-16', // not in the preset list
        oilType: OilType.MINERAL,
        oilVolumeMl: 3_500, // not a preset volume
      }) as never,
      WizardStep.PRICE,
    );
    expect(session.viscosityIsCustom).toBe(true);
    expect(session.volumeIsCustom).toBe(true);
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
  /** A service whose bot records whatever caption/text it is asked to send. */
  function makeCaptureService() {
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
    return { svc, sent };
  }

  it('includes the seller-chosen category (Russian label, not the enum)', async () => {
    const { svc, sent } = makeCaptureService();

    await svc.sendPreviewToChat(
      1,
      draft(1, ['a'], {
        vehicleCategory: PartVehicleCategory.SUSPENSION_AND_STEERING,
      }),
      ['https://cdn/img0.webp'], // single photo → caption on sendPhoto
    );

    const caption = sent.find((s) => s.caption?.includes('Категория'))?.caption;
    expect(caption).toBeDefined();
    expect(caption).toContain('Ходовая и Рулевое'); // label, not the enum value
    expect(caption).not.toContain('SUSPENSION_AND_STEERING');
    // The full listing detail lines are still present.
    expect(caption).toContain('Название');
    expect(caption).toContain('Цена');
  });

  it('renders a MOTOR_OIL listing with its own attributes and NO spare-part lines', async () => {
    const { svc, sent } = makeCaptureService();

    await svc.sendPreviewToChat(
      1,
      draft(1, ['a'], {
        kind: ProductKind.MOTOR_OIL,
        vehicleCategory: null,
        oilViscosity: '5W-30',
        oilType: OilType.SYNTHETIC,
        oilVolumeMl: 4000,
        metadata: {
          ...metadata,
          title: 'Mobil 1 ESP 5W-30 4L',
          brand: null,
          models: [],
          vehicles: [],
          // A "Другое" oil: no vehicle was named, so it is universal and the
          // preview shows no vehicle line.
          isUniversal: true,
          gm_number: null,
        },
      }),
      ['https://cdn/img0.webp'],
    );

    const caption = sent[0]?.caption;
    expect(caption).toBeDefined();
    // The oil's own attributes, in Russian.
    expect(caption).toContain('Вязкость');
    expect(caption).toContain('5W-30');
    expect(caption).toContain('Синтетическое');
    expect(caption).toContain('4 л');
    // Shared lines still render.
    expect(caption).toContain('Mobil 1 ESP 5W-30 4L');
    expect(caption).toContain('Цена');
    // Spare-part concepts must NOT appear on an oil.
    expect(caption).not.toContain('Автомобиль');
    expect(caption).not.toContain('Категория');
    expect(caption).not.toContain('OEM');
    expect(caption).not.toContain('GM');
  });
});

describe('TelegramService — seller approval notification', () => {
  /** A service whose bot records every message it is asked to send. */
  function makeNotifyService(sendMessage?: jest.Mock) {
    const sent: { chatId: number; text: string }[] = [];
    const svc = makeService(makePrisma(), makeCloudinary(), makeProjection(), {
      bot: {
        telegram: {
          sendMessage:
            sendMessage ??
            (async (chatId: number, text: string) => {
              sent.push({ chatId, text });
              return {} as unknown;
            }),
        },
      },
    });
    return { svc, sent };
  }

  it('sends the approval message to the seller’s chat, unprompted', async () => {
    const { svc, sent } = makeNotifyService();

    await svc.onSellerApproved({ sellerId: 7, tgId: BigInt(123456) });

    expect(sent).toHaveLength(1);
    // tgId IS the chat id — the seller needs to have done nothing at all.
    expect(sent[0].chatId).toBe(123456);
    expect(sent[0].text).toBe(SELLER_APPROVED_MESSAGE);
  });

  it('the message is the exact approved Russian copy', async () => {
    const { svc, sent } = makeNotifyService();

    await svc.onSellerApproved({ sellerId: 7, tgId: BigInt(1) });

    expect(sent[0].text).toBe(
      '✅ Ваша заявка успешно одобрена!\n\n' +
        'Теперь вы можете публиковать товары в Mator.\n\n' +
        'Нажмите /start, чтобы открыть меню и начать добавление товаров.',
    );
  });

  it('swallows a delivery failure — approval must never depend on the notice', async () => {
    // The seller blocked the bot / never opened a chat / Telegram is down. The
    // approval is already committed, so this can only be logged.
    const failing = jest.fn().mockRejectedValue(new Error('bot was blocked'));
    const { svc } = makeNotifyService(failing);

    await expect(
      svc.onSellerApproved({ sellerId: 7, tgId: BigInt(123456) }),
    ).resolves.toBeUndefined();
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('swallows a bot that never launched (no telegram client at all)', async () => {
    const svc = makeService(makePrisma(), makeCloudinary(), makeProjection(), {
      bot: undefined,
    });

    await expect(
      svc.onSellerApproved({ sellerId: 7, tgId: BigInt(1) }),
    ).resolves.toBeUndefined();
  });
});

// ── The confirmation CAPTION, built from a PendingProduct ────────────────────
// Regression: `buildPreview` is the last hop before the seller reads the
// message, and it forwarded the oil attributes to `previewLines` while silently
// dropping `antifreezeWeightG`. The weight was on the draft, on the pending
// record, and correctly rendered by `previewLines` — so every layer tested in
// isolation looked right, and the caption still said "Вес: —" for a weight the
// seller had just typed. Nothing covered this seam; these tests do.
//
// They assert on the CAPTION `buildPreview` returns (not on `previewLines`),
// because the caption is what the bug was about.
describe('buildPreview — the confirmation caption', () => {
  /** The caption a seller would actually read for this pending listing. */
  function captionFor(pending: ReturnType<typeof draft>): string {
    const svc = makeService(makePrisma(), makeCloudinary());
    return svc.buildPreview(pending).caption;
  }

  it('shows a 10 кг antifreeze weight', () => {
    expect(captionFor(antifreezePending(1, 10_000))).toContain('10 кг');
  });

  it('shows a fractional 2.5 кг weight', () => {
    expect(captionFor(antifreezePending(1, 2_500))).toContain('2.5 кг');
  });

  it('shows a sub-kilogram weight in grams, not kilograms', () => {
    const caption = captionFor(antifreezePending(1, 500));
    expect(caption).toContain('500 г');
    // Guards the unit confusion the formatter exists to prevent: 500 g must
    // never read as "500 кг" (nor as "0.5 кг", which formatWeight does not emit).
    expect(caption).not.toContain('500 кг');
  });

  it('renders the em-dash fallback when no weight was recorded', () => {
    const caption = captionFor(antifreezePending(1, null));
    expect(caption).toContain('Вес');
    expect(caption).toContain('—');
    expect(caption).not.toContain('null');
  });

  it('labels the weight line rather than showing a bare number', () => {
    const caption = captionFor(antifreezePending(1, 10_000));
    expect(caption).toMatch(/Вес.*10 кг/);
    // An antifreeze is sold by WEIGHT: no oil line may appear on its caption,
    // and above all no oil TYPE — that column selects an oil's MXIK.
    expect(caption).not.toContain('Вязкость');
    expect(caption).not.toContain('Объём');
    expect(caption).not.toContain('Синтетическое');
  });

  it('leaves the MOTOR_OIL caption unchanged (viscosity / type / volume, no weight)', () => {
    const caption = captionFor(oilPending(1));
    expect(caption).toContain('5W-30');
    expect(caption).toContain('Синтетическое');
    expect(caption).toContain('4 л');
    expect(caption).not.toContain('Вес');
  });

  it('leaves the SPARE_PART caption unchanged (no weight line)', () => {
    const caption = captionFor(draft(1));
    expect(caption).toContain('96234567');
    expect(caption).not.toContain('Вес');
    expect(caption).not.toContain('Вязкость');
  });
});
