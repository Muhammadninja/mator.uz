// Unit tests for the photos-first draft-flow orchestration methods on
// TelegramService — the ONLY product-creation path. Like the confirmation spec,
// the service is built via
// Object.create(prototype) + Object.assign so we exercise the private helpers
// without Nest DI or a live bot. All collaborators are mocked.
//
// Covered:
//   • handlePhotos: creates the draft, enqueues a job per image, stores
//     jobIds, advances the FSM to BRAND, and starts the questionnaire.
//   • handleFormAdvance: persists fields to the draft each step; on
//     QUESTIONNAIRE_DONE consumes the session and calls the coordinator; shows the
//     holding message only while still processing (and never when an image failed).
//   • presentDraftPreview: builds the pending confirmation from a READY draft and
//     sends the preview; is idempotent for a non-READY_FOR_PREVIEW draft.
//   • onDraftImagesFailed: sends the retry/cancel buttons to the seller's chat.

import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Decimal } from '@prisma/client/runtime/library';
import { TelegramService } from './telegram.service';
import {
  makeFakeLock,
  type TelegramServiceHarness,
} from './draft-lock.test-util';
import {
  WizardSessionStore,
  WizardStep,
  beginQuestionnaire,
  inputPrice,
  selectBrand,
} from './product-wizard';

type AnyService = TelegramServiceHarness;

function makeService(over: Partial<Record<string, unknown>> = {}): AnyService {
  const svc = Object.create(TelegramService.prototype) as AnyService;
  Object.assign(svc, {
    logger: { log() {}, warn() {}, error() {}, debug() {} },
    wizard: new WizardSessionStore(),
    sessionExpiry: new Map(),
    pending: new Map(),
    // Collaborators (overridable per test).
    sellers: {
      findByTgId: jest.fn().mockResolvedValue({ id: 1, status: 'ACTIVE' }),
    },
    drafts: {},
    draftCoordinator: { onFormStep: jest.fn().mockResolvedValue(undefined) },
    queue: {
      enqueueImage: jest.fn().mockResolvedValue({ id: 'job1' }),
      reenqueueImage: jest.fn().mockResolvedValue({ id: 'job1' }),
      removeImageJob: jest.fn().mockResolvedValue(undefined),
    },
    cloudinary: { deleteAssets: jest.fn().mockResolvedValue(undefined) },
    catalogProjection: { projectStock: jest.fn().mockResolvedValue(undefined) },
    telemetry: { event: jest.fn(), metric: jest.fn() },
    // A real (in-memory) mutex, not a pass-through: the guarded paths must
    // behave correctly both when they win the lock and when they lose it.
    locks: makeFakeLock(),
    bot: {
      telegram: {
        sendMessage: jest.fn().mockResolvedValue(undefined),
        sendPhoto: jest.fn().mockResolvedValue(undefined),
        sendMediaGroup: jest.fn().mockResolvedValue(undefined),
      },
    },
    // touchSession/clearSessionExpiry are real (operate on sessionExpiry Map) but
    // harmless here; stub them to avoid timer noise.
    touchSession: jest.fn(),
    clearSessionExpiry: jest.fn(),
    discardSessionPhotos: jest.fn().mockResolvedValue(undefined),
    ...over,
  });
  return svc;
}

function makeCtx() {
  return { reply: jest.fn().mockResolvedValue(undefined) };
}

/** The prisma surface `commitPending` touches (incl. persistVehicleLinks). */
function makePrismaStub() {
  return {
    product: {
      upsert: jest.fn().mockResolvedValue({ id: 10 }),
    },
    productImage: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
    stock: { upsert: jest.fn().mockResolvedValue({ id: 20 }) },
    partModel: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      upsert: jest.fn().mockResolvedValue({ id: 30 }),
    },
    brand: { upsert: jest.fn().mockResolvedValue({ id: 40 }) },
    carModel: { upsert: jest.fn().mockResolvedValue({ id: 50 }) },
  };
}

/**
 * A complete READY_FOR_PREVIEW draft — every field `rebuildPendingFromDraft` needs
 * to reconstruct a pending confirmation from the DB when the in-memory cache is gone.
 */
function readyDraft(over: Record<string, unknown> = {}) {
  return {
    id: 'draft_1',
    sellerId: 1,
    status: 'READY_FOR_PREVIEW',
    version: 3,
    kind: 'SPARE_PART',
    title: 'Фара левая',
    description: null,
    brand: 'Chevrolet',
    model: 'Nexia',
    category: 'SEDAN',
    partNumber: '96littleendian',
    partNumberType: 'UNKNOWN',
    oilViscosity: null,
    oilType: null,
    oilVolumeMl: null,
    priceUzs: new Decimal(250000),
    formStep: 'QUESTIONNAIRE_DONE',
    images: [
      {
        status: 'READY',
        processedUrl: 'https://cdn/p0.jpg',
        processedPublicId: 'proc_0',
        sortOrder: 0,
      },
      {
        status: 'READY',
        processedUrl: 'https://cdn/p1.jpg',
        processedPublicId: 'proc_1',
        sortOrder: 1,
      },
    ],
    ...over,
  };
}

describe('TelegramService — draft flow (photos-first)', () => {
  describe('handlePhotos (the ONE image-pipeline entry)', () => {
    it('creates a draft, enqueues a job per image, advances to BRAND, and starts the questionnaire', async () => {
      const drafts = {
        createWithImages: jest.fn().mockResolvedValue({
          id: 'draft_1',
          images: [
            { id: 'dimg_1', sortOrder: 0 },
            { id: 'dimg_2', sortOrder: 1 },
          ],
        }),
        setImageJobId: jest.fn().mockResolvedValue(undefined),
      };
      const svc = makeService({ drafts });
      const ctx = makeCtx();
      const session = svc.wizard.start(7); // step = PHOTOS_FIRST

      await svc.handlePhotos(ctx, 7, session, ['file_a', 'file_b']);

      expect(drafts.createWithImages).toHaveBeenCalledTimes(1);
      const arg = drafts.createWithImages.mock.calls[0][0];
      expect(arg.images).toEqual([
        { sortOrder: 0, tgFileId: 'file_a' },
        { sortOrder: 1, tgFileId: 'file_b' },
      ]);
      expect(session.step).toBe(WizardStep.BRAND); // FSM advanced
      expect(session.draftId).toBe('draft_1');
      expect(svc.queue.enqueueImage).toHaveBeenCalledTimes(2);
      expect(drafts.setImageJobId).toHaveBeenCalledWith('dimg_1', 'job1');
      // "Фото получены" + the BRAND prompt.
      expect(ctx.reply).toHaveBeenCalled();
    });

    it('re-gates the seller: a PENDING seller cannot start processing', async () => {
      const drafts = { createWithImages: jest.fn() };
      const svc = makeService({
        drafts,
        sellers: {
          findByTgId: jest.fn().mockResolvedValue({ id: 1, status: 'PENDING' }),
        },
      });
      const ctx = makeCtx();
      const session = svc.wizard.start(7);

      await svc.handlePhotos(ctx, 7, session, ['file_a']);

      expect(drafts.createWithImages).not.toHaveBeenCalled();
      expect(session.step).toBe(WizardStep.PHOTOS_FIRST); // unchanged
    });
  });

  describe('handleFormAdvance', () => {
    it('persists fields and re-prompts while the questionnaire continues', async () => {
      const drafts = { updateForm: jest.fn().mockResolvedValue(undefined) };
      const svc = makeService({ drafts });
      const ctx = makeCtx();
      const session = svc.wizard.start(7);
      beginQuestionnaire(session); // → BRAND
      session.draftId = 'draft_1';
      selectBrand(session, 0); // → MODEL
      const sendStepPrompt = jest
        .spyOn(svc, 'sendStepPrompt')
        .mockResolvedValue(undefined);

      await svc.handleFormAdvance(ctx, 7, session);

      expect(drafts.updateForm).toHaveBeenCalledWith(
        'draft_1',
        expect.objectContaining({ formStep: WizardStep.MODEL }),
      );
      expect(sendStepPrompt).toHaveBeenCalled();
      expect(svc.draftCoordinator.onFormStep).not.toHaveBeenCalled(); // not done yet
    });

    it('on QUESTIONNAIRE_DONE: persists, consumes the session, calls the coordinator, and shows the holding message while still processing', async () => {
      const drafts = {
        updateForm: jest.fn().mockResolvedValue(undefined),
        findWithImages: jest.fn().mockResolvedValue({
          status: 'CREATING',
          images: [{ status: 'PROCESSING' }],
        }),
      };
      const svc = makeService({ drafts });
      const ctx = makeCtx();
      // Drive a session to QUESTIONNAIRE_DONE.
      const session = svc.wizard.start(7);
      session.draftId = 'draft_1';
      session.step = WizardStep.PRICE;
      session.brand = 'Chevrolet';
      session.model = 'Cobalt';
      session.category = 'ENGINE';
      session.title = 'Фильтр';
      inputPrice(session, '250 000'); // → QUESTIONNAIRE_DONE (parallel)

      await svc.handleFormAdvance(ctx, 7, session);

      expect(svc.draftCoordinator.onFormStep).toHaveBeenCalledWith('draft_1');
      expect(svc.wizard.get(7)).toBeUndefined(); // session consumed
      const texts = ctx.reply.mock.calls.map((c: unknown[]) => c[0]);
      expect(texts.some((t: string) => t.includes('Завершаем обработку'))).toBe(
        true,
      );
    });

    it('on QUESTIONNAIRE_DONE with a failed image: does NOT show the holding message (the failure notice owns that)', async () => {
      const drafts = {
        updateForm: jest.fn().mockResolvedValue(undefined),
        findWithImages: jest.fn().mockResolvedValue({
          status: 'CREATING',
          images: [{ status: 'READY' }, { status: 'FAILED' }],
        }),
      };
      const svc = makeService({ drafts });
      const ctx = makeCtx();
      const session = svc.wizard.start(7);
      session.draftId = 'draft_1';
      session.step = WizardStep.PRICE;
      session.brand = 'Chevrolet';
      session.model = 'Cobalt';
      session.category = 'ENGINE';
      session.title = 'Фильтр';
      inputPrice(session, '250 000');

      await svc.handleFormAdvance(ctx, 7, session);

      const texts = ctx.reply.mock.calls.map((c: unknown[]) => c[0]);
      expect(texts.some((t: string) => t.includes('Завершаем обработку'))).toBe(
        false,
      );
    });
  });

  describe('presentDraftPreview', () => {
    it('builds pending from a READY draft and sends the preview to the chat', async () => {
      const draft = {
        id: 'draft_1',
        sellerId: 1,
        status: 'READY_FOR_PREVIEW',
        kind: 'SPARE_PART',
        title: 'Фильтр',
        brand: 'Chevrolet',
        model: 'Cobalt',
        category: 'ENGINE',
        description: null,
        partNumber: '96535062',
        partNumberType: 'OEM',
        oilViscosity: null,
        oilType: null,
        oilVolumeMl: null,
        priceUzs: new Decimal(250000),
        images: [
          {
            status: 'READY',
            sortOrder: 1,
            processedUrl: 'u1',
            processedPublicId: 'p1',
          },
          {
            status: 'READY',
            sortOrder: 0,
            processedUrl: 'u0',
            processedPublicId: 'p0',
          },
        ],
      };
      const drafts = {
        findWithImages: jest.fn().mockResolvedValue(draft),
        claimPreviewSend: jest.fn().mockResolvedValue(true), // won the claim
      };
      const svc = makeService({ drafts });
      const storePending = jest
        .spyOn(svc, 'storePending')
        .mockReturnValue(false);

      await svc.presentDraftPreview('draft_1', 7);

      // processedUrls sorted by sortOrder. The spy is taken on the harness's
      // index-signature type, so its recorded args come back as `unknown`;
      // naming the shape here restores the field checks on the assertions below.
      const pendingArg = storePending.mock.calls[0][0] as {
        processedUrls: string[];
        tgUserId: number;
      };
      expect(pendingArg.processedUrls).toEqual(['u0', 'u1']);
      expect(pendingArg.tgUserId).toBe(7);
      // A single-or-multi send happened via bot.telegram.
      const sentMedia =
        svc.bot.telegram.sendMediaGroup.mock.calls.length +
        svc.bot.telegram.sendPhoto.mock.calls.length;
      expect(sentMedia).toBeGreaterThan(0);
    });

    it('is idempotent: a draft not in READY_FOR_PREVIEW is skipped', async () => {
      const drafts = {
        findWithImages: jest
          .fn()
          .mockResolvedValue({ status: 'PUBLISHED', images: [] }),
        claimPreviewSend: jest.fn(),
      };
      const svc = makeService({ drafts });
      const storePending = jest.spyOn(svc, 'storePending');

      await svc.presentDraftPreview('draft_1', 7);

      expect(storePending).not.toHaveBeenCalled();
      expect(drafts.claimPreviewSend).not.toHaveBeenCalled(); // never got to the claim
    });

    it('LOSES the atomic claim (a racing candidate already sent) → bails, no storePending, no send', async () => {
      const draft = {
        id: 'draft_1',
        sellerId: 1,
        status: 'READY_FOR_PREVIEW',
        kind: 'SPARE_PART',
        title: 'Фильтр',
        brand: 'Chevrolet',
        model: 'Cobalt',
        category: 'ENGINE',
        description: null,
        partNumber: null,
        partNumberType: 'UNKNOWN',
        oilViscosity: null,
        oilType: null,
        oilVolumeMl: null,
        priceUzs: new Decimal(250000),
        images: [
          {
            status: 'READY',
            sortOrder: 0,
            processedUrl: 'u0',
            processedPublicId: 'p0',
          },
        ],
      };
      const drafts = {
        findWithImages: jest.fn().mockResolvedValue(draft),
        claimPreviewSend: jest.fn().mockResolvedValue(false), // lost the race
      };
      const svc = makeService({ drafts });
      const storePending = jest.spyOn(svc, 'storePending');

      await svc.presentDraftPreview('draft_1', 7);

      expect(drafts.claimPreviewSend).toHaveBeenCalledWith('draft_1');
      expect(storePending).not.toHaveBeenCalled(); // would delete the winner's assets
      const sends =
        svc.bot.telegram.sendMediaGroup.mock.calls.length +
        svc.bot.telegram.sendPhoto.mock.calls.length +
        svc.bot.telegram.sendMessage.mock.calls.length;
      expect(sends).toBe(0);
    });
  });

  describe('onDraftImagesFailed', () => {
    it('sends retry/cancel buttons to the seller chat', async () => {
      const svc = makeService();
      await svc.onDraftImagesFailed({
        draftId: 'draft_1',
        tgId: 7n,
        failedCount: 2,
      });
      expect(svc.bot.telegram.sendMessage).toHaveBeenCalledTimes(1);
      const [chatId, text] = svc.bot.telegram.sendMessage.mock.calls[0];
      expect(chatId).toBe(7);
      expect(text).toContain('2');
    });
  });

  /**
   * A new listing must not begin while the PREVIOUS one's photos are still being
   * processed. The bug this locks down: the seller sent/changed a photo, the batch
   * went to the worker, and the bot happily opened a SECOND wizard — so when the
   * batch finished, the old draft's finished preview arrived in the middle of the
   * new listing and looked like the bot had answered the wrong thing.
   *
   * The gate is the DB state the rendezvous itself reads (a CREATING draft with a
   * PROCESSING image row), never a separate in-memory boolean — see
   * ProductDraftService.findImagesInFlight.
   */
  describe('a new listing is blocked while images are processing', () => {
    const PROCESSING_MSG = '📸 Фото обрабатывается, пожалуйста, подождите.';

    /** A draft whose batch is genuinely mid-flight. */
    function inFlightDraft(over: Record<string, unknown> = {}) {
      return {
        id: 'draft_busy',
        images: [
          { id: 'dimg_1', status: 'PROCESSING', processedUrl: null },
          { id: 'dimg_2', status: 'READY', processedUrl: 'https://cdn/a.jpg' },
        ],
        ...over,
      };
    }

    it('startProductCreation refuses to open a wizard and creates NO draft', async () => {
      const drafts = {
        findAwaitingPreview: jest.fn().mockResolvedValue(null),
        findImagesInFlight: jest.fn().mockResolvedValue(inFlightDraft()),
        findResumable: jest.fn(),
        createWithImages: jest.fn(),
        setImageJobId: jest.fn().mockResolvedValue(undefined),
      };
      const svc = makeService({ drafts });
      const ctx = makeCtx();

      await svc.startProductCreation(ctx, 7, 1);

      expect(ctx.reply).toHaveBeenCalledWith(PROCESSING_MSG);
      // No new wizard session, and no new draft row.
      expect(svc.wizard.get(7)).toBeUndefined();
      expect(drafts.createWithImages).not.toHaveBeenCalled();
      // Never even reached the resume prompt (which offers "Начать заново").
      expect(drafts.findResumable).not.toHaveBeenCalled();
    });

    it('the block is checked BEFORE the resume prompt, so "🆕 Начать заново" is never offered mid-batch', async () => {
      const drafts = {
        findAwaitingPreview: jest.fn().mockResolvedValue(null),
        findImagesInFlight: jest.fn().mockResolvedValue(inFlightDraft()),
        findResumable: jest.fn().mockResolvedValue(inFlightDraft()),
        setImageJobId: jest.fn().mockResolvedValue(undefined),
      };
      const svc = makeService({ drafts });
      const ctx = makeCtx();

      await svc.startProductCreation(ctx, 7, 1);

      const texts = ctx.reply.mock.calls.map((c: unknown[]) => c[0]);
      expect(texts).toContain(PROCESSING_MSG);
      expect(
        texts.some((t: string) => t.includes('незавершённое объявление')),
      ).toBe(false);
    });

    it('repeated taps stay idempotent: same message, still no draft and no session', async () => {
      const drafts = {
        findAwaitingPreview: jest.fn().mockResolvedValue(null),
        findImagesInFlight: jest.fn().mockResolvedValue(inFlightDraft()),
        findResumable: jest.fn(),
        createWithImages: jest.fn(),
        setImageJobId: jest.fn().mockResolvedValue(undefined),
      };
      const svc = makeService({ drafts });
      const ctx = makeCtx();

      await svc.startProductCreation(ctx, 7, 1);
      await svc.startProductCreation(ctx, 7, 1);
      await svc.startProductCreation(ctx, 7, 1);

      const texts = ctx.reply.mock.calls.map((c: unknown[]) => c[0]);
      expect(texts).toEqual([PROCESSING_MSG, PROCESSING_MSG, PROCESSING_MSG]);
      expect(drafts.createWithImages).not.toHaveBeenCalled();
      expect(svc.wizard.get(7)).toBeUndefined();
    });

    it('blocking still heals a stuck row, so a lost job cannot strand the draft behind its own block', async () => {
      // The row the block keys on is exactly the row that may have lost its job.
      // Without healing here, "please wait" would never lift.
      const drafts = {
        findAwaitingPreview: jest.fn().mockResolvedValue(null),
        findImagesInFlight: jest.fn().mockResolvedValue(inFlightDraft()),
        findResumable: jest.fn(),
        setImageJobId: jest.fn().mockResolvedValue(undefined),
      };
      const svc = makeService({ drafts });

      await svc.startProductCreation(makeCtx(), 7, 1);

      expect(svc.queue.reenqueueImage).toHaveBeenCalledWith({
        draftId: 'draft_busy',
        imageId: 'dimg_1',
      });
    });

    it('once the batch SUCCEEDS the block lifts and the flow continues (preview is presented)', async () => {
      const drafts = {
        // Batch settled → no longer in flight; the finished draft awaits preview.
        findImagesInFlight: jest.fn().mockResolvedValue(null),
        findAwaitingPreview: jest.fn().mockResolvedValue({ id: 'draft_busy' }),
        findResumable: jest.fn(),
      };
      const svc = makeService({ drafts });
      const present = jest
        .spyOn(svc, 'presentDraftPreview')
        .mockResolvedValue(undefined);
      const ctx = makeCtx();

      await svc.startProductCreation(ctx, 7, 1);

      expect(present).toHaveBeenCalledWith('draft_busy', 7);
      const texts = ctx.reply.mock.calls.map((c: unknown[]) => c[0]);
      expect(texts).not.toContain(PROCESSING_MSG);
    });

    it('once the batch FAILS the block lifts too, so the seller can reach retry/cancel', async () => {
      // A FAILED row is settled, not in flight — findImagesInFlight matches only
      // PROCESSING. The seller must not be locked out of recovery.
      const failedDraft = {
        id: 'draft_busy',
        formStep: WizardStep.PRICE,
        images: [{ id: 'dimg_1', status: 'FAILED', processedUrl: null }],
      };
      const drafts = {
        findImagesInFlight: jest.fn().mockResolvedValue(null),
        findAwaitingPreview: jest.fn().mockResolvedValue(null),
        findResumable: jest.fn().mockResolvedValue(failedDraft),
      };
      const svc = makeService({ drafts });
      const ctx = makeCtx();

      await svc.startProductCreation(ctx, 7, 1);

      const texts = ctx.reply.mock.calls.map((c: unknown[]) => c[0]);
      expect(texts).not.toContain(PROCESSING_MSG);
      // The normal resume prompt is offered instead.
      expect(
        texts.some((t: string) => t.includes('незавершённое объявление')),
      ).toBe(true);
    });

    it('a draft with NO processing rows never triggers the block (normal questionnaire in progress)', async () => {
      const drafts = {
        findImagesInFlight: jest.fn().mockResolvedValue(null),
        findAwaitingPreview: jest.fn().mockResolvedValue(null),
        findResumable: jest.fn().mockResolvedValue(null),
      };
      const svc = makeService({ drafts });
      const ctx = makeCtx();

      await svc.startProductCreation(ctx, 7, 1);

      // Fresh wizard opened as usual.
      expect(svc.wizard.get(7)).toBeDefined();
      expect(svc.wizard.get(7).step).toBe(WizardStep.PHOTOS_FIRST);
    });
  });

  describe('recovery / hardening', () => {
    it('startProductCreation re-presents a READY_FOR_PREVIEW draft (lost-preview recovery)', async () => {
      const awaiting = { id: 'draft_ready' };
      const drafts = {
        findAwaitingPreview: jest.fn().mockResolvedValue(awaiting),
        findResumable: jest.fn(),
      };
      const svc = makeService({ drafts });
      const present = jest
        .spyOn(svc, 'presentDraftPreview')
        .mockResolvedValue(undefined);

      await svc.startProductCreation(makeCtx(), 7, 1);

      expect(present).toHaveBeenCalledWith('draft_ready', 7);
      // Did NOT fall through to the resume prompt.
      expect(drafts.findResumable).not.toHaveBeenCalled();
    });

    it('retryFailedImages uses reenqueueImage (not enqueueImage) so a retained failed job is replaced', async () => {
      const drafts = {
        findResumable: jest
          .fn()
          .mockResolvedValue({ id: 'draft_1', images: [] }),
        resetFailedImages: jest
          .fn()
          .mockResolvedValue([
            { id: 'dimg_1', status: 'PROCESSING', processedUrl: null },
          ]),
        setImageJobId: jest.fn().mockResolvedValue(undefined),
      };
      const svc = makeService({ drafts });

      await svc.retryFailedImages(makeCtx(), 7);

      expect(svc.queue.reenqueueImage).toHaveBeenCalledWith({
        draftId: 'draft_1',
        imageId: 'dimg_1',
      });
      expect(svc.queue.enqueueImage).not.toHaveBeenCalled();
    });

    it('reenqueueStuckImages re-enqueues PROCESSING rows without a result (heals the enqueue-crash window)', async () => {
      const drafts = { setImageJobId: jest.fn().mockResolvedValue(undefined) };
      const svc = makeService({ drafts });
      const draft = {
        id: 'draft_1',
        images: [
          { id: 'a', status: 'PROCESSING', processedUrl: null }, // stuck → re-enqueue
          { id: 'b', status: 'READY', processedUrl: 'u' }, // done → left alone
          { id: 'c', status: 'PROCESSING', processedUrl: 'u2' }, // has result → left alone
        ],
      };

      await svc.reenqueueStuckImages(draft);

      expect(svc.queue.reenqueueImage).toHaveBeenCalledTimes(1);
      expect(svc.queue.reenqueueImage).toHaveBeenCalledWith({
        draftId: 'draft_1',
        imageId: 'a',
      });
    });

    it('resuming a draft reopened by "⬅️ Назад" enqueues NOTHING (all images already READY)', async () => {
      // A draft moved READY_FOR_PREVIEW → CREATING for a text/price edit keeps its
      // READY images. /start during that edit must not re-enqueue them: the queue is
      // not involved in an edit at all, so no image is ever processed twice.
      const reopened = {
        id: 'draft_1',
        formStep: WizardStep.PRICE,
        kind: 'SPARE_PART',
        brand: 'Chevrolet',
        model: 'Cobalt',
        category: 'ENGINE',
        title: 'Фильтр',
        description: null,
        partNumberType: 'UNKNOWN',
        partNumber: null,
        oilViscosity: null,
        oilType: null,
        oilVolumeMl: null,
        priceUzs: new Decimal(250000),
        images: [
          { id: 'a', status: 'READY', processedUrl: 'u1', jobId: 'j1' },
          { id: 'b', status: 'READY', processedUrl: 'u2', jobId: 'j2' },
        ],
      };
      const drafts = {
        findResumable: jest.fn().mockResolvedValue(reopened),
        setImageJobId: jest.fn().mockResolvedValue(undefined),
      };
      const svc = makeService({ drafts });

      await svc.resumeDraft(makeCtx(), 7);

      expect(svc.queue.reenqueueImage).not.toHaveBeenCalled();
      expect(svc.queue.enqueueImage).not.toHaveBeenCalled();
      // The dialogue is restored at the saved edit step with the draft's data.
      expect(svc.wizard.get(7)?.step).toBe(WizardStep.PRICE);
      expect(svc.wizard.get(7)?.draftId).toBe('draft_1');
    });

    it('finalizePublishedDraft marks the draft PUBLISHED and deletes ONLY the original assets', async () => {
      const drafts = {
        publishDraft: jest.fn().mockResolvedValue(true),
        collectOriginalPublicIds: jest
          .fn()
          .mockResolvedValue(['orig_0', 'orig_1']),
      };
      const svc = makeService({ drafts });

      await svc.finalizePublishedDraft('draft_1', 1);

      expect(drafts.publishDraft).toHaveBeenCalledWith('draft_1');
      expect(svc.cloudinary.deleteAssets).toHaveBeenCalledWith([
        'orig_0',
        'orig_1',
      ]);
      expect(svc.telemetry.metric).toHaveBeenCalled(); // draft.published metric
    });

    it('finalizePublishedDraft swallows errors (product already committed)', async () => {
      const drafts = {
        publishDraft: jest.fn().mockRejectedValue(new Error('db down')),
        collectOriginalPublicIds: jest.fn(),
      };
      const svc = makeService({ drafts });

      await expect(
        svc.finalizePublishedDraft('draft_1', 1),
      ).resolves.toBeUndefined();
    });
  });

  // Regression: a CANCELLED draft must never be resumed or re-previewed.
  //   preview → cancel → /start  ⇒  the old preview must NOT come back.
  // The cancel used to be a no-op whenever the in-memory `pending` record was
  // already gone (evicted after CONFIRMATION_TTL_MS, or lost on a restart): the
  // draft stayed READY_FOR_PREVIEW, so /start's lost-preview recovery re-sent it.
  describe('cancel is terminal (regression)', () => {
    it('cancels in the DB even when the in-memory pending record is gone (TTL evicted / restart)', async () => {
      const drafts = {
        // No pending → cancel must resolve the draft from the DB instead.
        findAwaitingPreview: jest.fn().mockResolvedValue(readyDraft()),
        findWithImages: jest.fn().mockResolvedValue(readyDraft()),
        collectOriginalPublicIds: jest.fn().mockResolvedValue(['orig_0']),
        tryTransition: jest.fn().mockResolvedValue(true),
      };
      const svc = makeService({ drafts });
      expect(svc.pending.size).toBe(0); // the exact broken precondition

      await svc.cancelPendingDraft(7);

      expect(drafts.tryTransition).toHaveBeenCalledWith(
        'draft_1',
        'READY_FOR_PREVIEW',
        'CANCELLED',
        3,
      );
      // Assets are not orphaned: the processed ids (which only the vanished pending
      // record used to know about) are rebuilt from the draft's rows, and the
      // originals are collected as before.
      expect(svc.cloudinary.deleteAssets).toHaveBeenCalledWith([
        'proc_0',
        'proc_1',
      ]);
      expect(svc.cloudinary.deleteAssets).toHaveBeenCalledWith(['orig_0']);
    });

    it('after cancel, /start does NOT re-present the preview', async () => {
      // Model the DB: cancel flips the row, and the /start recovery query only
      // matches READY_FOR_PREVIEW — so once cancelled it must return null.
      let status = 'READY_FOR_PREVIEW';
      const drafts = {
        findAwaitingPreview: jest
          .fn()
          .mockImplementation(() =>
            Promise.resolve(
              status === 'READY_FOR_PREVIEW' ? readyDraft() : null,
            ),
          ),
        findResumable: jest.fn().mockResolvedValue(null),
        // The cancelled draft's images were all READY — nothing in flight.
        findImagesInFlight: jest.fn().mockResolvedValue(null),
        findWithImages: jest
          .fn()
          .mockImplementation(() => Promise.resolve(readyDraft({ status }))),
        collectOriginalPublicIds: jest.fn().mockResolvedValue([]),
        tryTransition: jest.fn().mockImplementation(() => {
          status = 'CANCELLED';
          return Promise.resolve(true);
        }),
      };
      const svc = makeService({ drafts });
      const present = jest
        .spyOn(svc, 'presentDraftPreview')
        .mockResolvedValue(undefined);

      // 1. Seller cancels the preview.
      await svc.cancelPendingDraft(7);
      expect(status).toBe('CANCELLED');

      // 2. Seller sends /start.
      const ctx = makeCtx();
      await svc.startProductCreation(ctx, 7, 1);

      // The old preview must NOT be re-sent; a fresh flow starts instead.
      expect(present).not.toHaveBeenCalled();
      expect(svc.wizard.get(7)).toBeDefined();
    });

    it('still cancels via the pending record when one exists (unchanged happy path)', async () => {
      const drafts = {
        findWithImages: jest.fn().mockResolvedValue(readyDraft()),
        findAwaitingPreview: jest.fn(),
        collectOriginalPublicIds: jest.fn().mockResolvedValue(['orig_0']),
        tryTransition: jest.fn().mockResolvedValue(true),
      };
      const svc = makeService({ drafts });
      svc.pending.set(7, {
        draftId: 'draft_1',
        publicIds: ['proc_0', 'proc_1'],
        expiry: setTimeout(() => {}, 0),
      });

      await svc.cancelPendingDraft(7);

      expect(drafts.findWithImages).toHaveBeenCalledWith('draft_1');
      expect(drafts.findAwaitingPreview).not.toHaveBeenCalled();
      expect(drafts.tryTransition).toHaveBeenCalledWith(
        'draft_1',
        'READY_FOR_PREVIEW',
        'CANCELLED',
        3,
      );
      expect(svc.pending.size).toBe(0);
    });
  });

  // The `pending` map is a UX cache, never the source of truth. Every preview-button
  // path must still work when it is empty (10-min TTL eviction, restart, redeploy) —
  // previously each of these aborted its state transition and told the seller to
  // /start over, silently stranding a READY_FOR_PREVIEW draft until the TTL sweep.
  describe('pending map is a cache, not the source of truth (regression)', () => {
    it('"⬅️ Назад" reopens the draft for edit after a cache miss', async () => {
      const drafts = {
        findAwaitingPreview: jest.fn().mockResolvedValue(readyDraft()),
        reopenForEdit: jest.fn().mockResolvedValue(true),
        findWithImages: jest.fn().mockResolvedValue(readyDraft()),
      };
      const svc = makeService({ drafts });
      const ctx = makeCtx();

      await svc.reopenDraftForEdit(ctx, 7);

      // Reopened under the draft's CURRENT version (the preview send already bumped
      // it), not a stale cached one.
      expect(drafts.reopenForEdit).toHaveBeenCalledWith(
        'draft_1',
        3,
        WizardStep.PRICE,
      );
      // The seller lands back in the wizard rather than being told to /start over.
      expect(svc.wizard.get(7)).toBeDefined();
      const said = ctx.reply.mock.calls.map(([t]: [string]) => t).join(' ');
      expect(said).not.toContain('Нет товара для редактирования');
    });

    it('"🖼 Изменить фото" clones the draft after a cache miss', async () => {
      const drafts = {
        findAwaitingPreview: jest.fn().mockResolvedValue(readyDraft()),
        findWithImages: jest.fn().mockResolvedValue(readyDraft()),
        collectPublicIds: jest.fn().mockResolvedValue(['proc_0']),
        cloneForPhotoReplacement: jest
          .fn()
          .mockResolvedValue(readyDraft({ id: 'draft_2', images: [] })),
      };
      const svc = makeService({ drafts });
      jest.spyOn(svc, 'discardDraftJobs').mockResolvedValue(undefined);
      const ctx = makeCtx();

      await svc.replaceDraftPhotos(ctx, 7);

      expect(drafts.cloneForPhotoReplacement).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceId: 'draft_1',
          expectedStatus: 'READY_FOR_PREVIEW',
        }),
      );
      expect(svc.wizard.get(7)).toBeDefined();
    });

    it('"✅ Подтвердить" commits the product after a cache miss', async () => {
      const drafts = {
        findAwaitingPreview: jest.fn().mockResolvedValue(readyDraft()),
        tryTransition: jest.fn().mockResolvedValue(true),
        publishDraft: jest.fn().mockResolvedValue(true),
        collectOriginalPublicIds: jest.fn().mockResolvedValue([]),
      };
      const svc = makeService({ drafts, prisma: makePrismaStub() });
      const ctx = makeCtx();

      await svc.commitPending(ctx, 7);

      // The product was actually written — not refused with "nothing to confirm".
      expect(svc.prisma.product.upsert).toHaveBeenCalled();
      expect(svc.prisma.stock.upsert).toHaveBeenCalled();
      const said = ctx.reply.mock.calls.map(([t]: [string]) => t).join(' ');
      expect(said).toContain('✅ Товар успешно добавлен');
    });

    it('commit claims the draft BEFORE writing, so a double-tap cannot commit twice', async () => {
      // Both taps miss the cache and rebuild the same draft; only the winner of the
      // versioned CAS may write. Without the claim, both would upsert a Product
      // (the gmNumber key does not dedupe an unlabeled part).
      let claimed = false;
      const drafts = {
        findAwaitingPreview: jest.fn().mockResolvedValue(readyDraft()),
        tryTransition: jest.fn().mockImplementation(() => {
          if (claimed) return Promise.resolve(false);
          claimed = true;
          return Promise.resolve(true);
        }),
        publishDraft: jest.fn().mockResolvedValue(true),
        collectOriginalPublicIds: jest.fn().mockResolvedValue([]),
      };
      const svc = makeService({ drafts, prisma: makePrismaStub() });

      await svc.commitPending(makeCtx(), 7);
      const ctx2 = makeCtx();
      await svc.commitPending(ctx2, 7);

      expect(drafts.tryTransition).toHaveBeenCalledTimes(2);
      expect(svc.prisma.product.upsert).toHaveBeenCalledTimes(1);
      const said = ctx2.reply.mock.calls.map(([t]: [string]) => t).join(' ');
      expect(said).toContain('уже обработано');
    });
  });

  // The commit claim is COMMITTING, never PUBLISHED: the status must not assert an
  // outcome that has not happened yet. A crash mid-write then leaves a recoverable,
  // sweepable draft instead of a PUBLISHED one with no product (whose assets the
  // sweep refuses to touch, leaking them forever).
  describe('COMMITTING claim (crash-safe commit)', () => {
    const commitDrafts = (over: Record<string, unknown> = {}) => ({
      findAwaitingPreview: jest.fn().mockResolvedValue(readyDraft()),
      tryTransition: jest.fn().mockResolvedValue(true),
      publishDraft: jest.fn().mockResolvedValue(true),
      collectOriginalPublicIds: jest.fn().mockResolvedValue(['orig_0']),
      ...over,
    });

    it('claims READY_FOR_PREVIEW → COMMITTING (not PUBLISHED) before the product write', async () => {
      const drafts = commitDrafts();
      const svc = makeService({ drafts, prisma: makePrismaStub() });
      const order: string[] = [];
      drafts.tryTransition.mockImplementation((...a: unknown[]) => {
        order.push(`claim:${String(a[2])}`);
        return Promise.resolve(true);
      });
      svc.prisma.product.upsert.mockImplementation(() => {
        order.push('product.upsert');
        return Promise.resolve({ id: 10 });
      });

      await svc.commitPending(makeCtx(), 7);

      expect(drafts.tryTransition).toHaveBeenCalledWith(
        'draft_1',
        'READY_FOR_PREVIEW',
        'COMMITTING',
        3,
      );
      // The claim strictly precedes the write — that ordering IS the guard.
      expect(order).toEqual(['claim:COMMITTING', 'product.upsert']);
    });

    it('closes the claim COMMITTING → PUBLISHED only after the product write succeeds', async () => {
      const drafts = commitDrafts();
      const svc = makeService({ drafts, prisma: makePrismaStub() });
      const order: string[] = [];
      svc.prisma.product.upsert.mockImplementation(() => {
        order.push('product.upsert');
        return Promise.resolve({ id: 10 });
      });
      drafts.publishDraft.mockImplementation(() => {
        order.push('publishDraft');
        return Promise.resolve(true);
      });

      await svc.commitPending(makeCtx(), 7);

      expect(order).toEqual(['product.upsert', 'publishDraft']);
      expect(drafts.publishDraft).toHaveBeenCalledWith('draft_1');
      // Publishing fires the telemetry again (the claim itself must not).
      expect(svc.telemetry.metric).toHaveBeenCalled();
    });

    it('a crash during the product write leaves the draft COMMITTING — never PUBLISHED', async () => {
      const drafts = commitDrafts();
      const svc = makeService({ drafts, prisma: makePrismaStub() });
      svc.prisma.product.upsert.mockRejectedValue(new Error('db down'));
      const ctx = makeCtx();

      await svc.commitPending(ctx, 7);

      // The claim happened; the publish did NOT. The draft is left COMMITTING, so
      // findExpired will reclaim its assets once the TTL passes.
      expect(drafts.tryTransition).toHaveBeenCalledWith(
        'draft_1',
        'READY_FOR_PREVIEW',
        'COMMITTING',
        3,
      );
      expect(drafts.publishDraft).not.toHaveBeenCalled();
      const said = ctx.reply.mock.calls.map(([t]: [string]) => t).join(' ');
      expect(said).toContain('Произошла ошибка');
    });

    it('a draft mid-commit is invisible to /start: not re-previewed and not resumable', async () => {
      // Both recovery queries are status-scoped (READY_FOR_PREVIEW / CREATING), so a
      // COMMITTING draft matches neither — the seller cannot double-submit it.
      const drafts = {
        findAwaitingPreview: jest.fn().mockResolvedValue(null),
        findResumable: jest.fn().mockResolvedValue(null),
        // A COMMITTING draft's images are all READY, so nothing is in flight.
        findImagesInFlight: jest.fn().mockResolvedValue(null),
      };
      const svc = makeService({ drafts });
      const present = jest
        .spyOn(svc, 'presentDraftPreview')
        .mockResolvedValue(undefined);

      await svc.startProductCreation(makeCtx(), 7, 1);

      expect(present).not.toHaveBeenCalled();
      // Falls through to a brand-new flow rather than touching the committing draft.
      expect(svc.wizard.get(7)).toBeDefined();
    });

    it('reports "nothing to confirm" only when the DB really has no draft awaiting preview', async () => {
      const drafts = {
        findAwaitingPreview: jest.fn().mockResolvedValue(null),
        tryTransition: jest.fn(),
      };
      const svc = makeService({ drafts, prisma: makePrismaStub() });
      const ctx = makeCtx();

      await svc.commitPending(ctx, 7);

      expect(drafts.tryTransition).not.toHaveBeenCalled();
      expect(svc.prisma.product.upsert).not.toHaveBeenCalled();
      const said = ctx.reply.mock.calls.map(([t]: [string]) => t).join(' ');
      expect(said).toContain('Нет товара для подтверждения');
    });
  });

  // The COMMITTING sweep guard (collectPublicIds) decides "is this processed asset a
  // live product's image?" by matching ProductImage.url. That is only sound while no
  // workflow rewrites a ProductImage row's url in place — an UPDATE would let an
  // asset silently stop matching and get deleted out from under a live product.
  // This test fails loudly if such a write is ever introduced.
  describe('ProductImage.url is never rewritten in place (guard invariant)', () => {
    const srcDir = join(__dirname, '..');

    function sourceFiles(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = join(dir, e.name);
        if (e.isDirectory()) return sourceFiles(full);
        return e.isFile() &&
          e.name.endsWith('.ts') &&
          !e.name.endsWith('.spec.ts')
          ? [full]
          : [];
      });
    }

    it('no production code issues an update/updateMany on productImage', () => {
      const offenders = sourceFiles(srcDir).filter((f) =>
        /productImage\s*\.\s*(update|updateMany)\b/.test(
          readFileSync(f, 'utf8'),
        ),
      );
      expect(offenders).toEqual([]);
    });

    it('no production code writes product_images via raw SQL', () => {
      const offenders = sourceFiles(srcDir).filter((f) => {
        const src = readFileSync(f, 'utf8');
        return (
          /\$(queryRaw|executeRaw)/.test(src) && /product_images/i.test(src)
        );
      });
      expect(offenders).toEqual([]);
    });

    it('the only productImage writes are the confirm path’s deleteMany + createMany', () => {
      const writers = sourceFiles(srcDir).filter((f) =>
        /productImage\s*\.\s*(create|createMany|delete|deleteMany|update|updateMany|upsert)\b/.test(
          readFileSync(f, 'utf8'),
        ),
      );
      expect(writers.map((f) => basename(f))).toEqual(['telegram.service.ts']);
    });
  });
});
