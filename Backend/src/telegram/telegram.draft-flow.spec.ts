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

import { Decimal } from '@prisma/client/runtime/library';
import { TelegramService } from './telegram.service';
import { makeFakeLock } from './draft-lock.test-util';
import {
  WizardSessionStore,
  WizardStep,
  beginQuestionnaire,
  inputPrice,
  selectBrand,
} from './product-wizard';

type AnyService = TelegramService & Record<string, any>;

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
        title: 'Фильтр',
        brand: 'Chevrolet',
        model: 'Cobalt',
        category: 'ENGINE',
        description: null,
        partNumber: '96535062',
        partNumberType: 'OEM',
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

      // processedUrls sorted by sortOrder.
      const pendingArg = storePending.mock.calls[0][0];
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
        title: 'Фильтр',
        brand: 'Chevrolet',
        model: 'Cobalt',
        category: 'ENGINE',
        description: null,
        partNumber: null,
        partNumberType: 'UNKNOWN',
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
        brand: 'Chevrolet',
        model: 'Cobalt',
        category: 'ENGINE',
        title: 'Фильтр',
        description: null,
        partNumberType: 'UNKNOWN',
        partNumber: null,
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
});
