// Coordination tests for the Redis-guarded draft/preview paths.
//
// The invariant every test here defends: **PostgreSQL wins over Redis.** The
// lock is a short-circuit that stops duplicate WORK; it is never what makes the
// outcome correct. So each scenario is asserted twice where it matters — once
// with the lock doing its job, and once with the lock unavailable (Redis down /
// stale-expired), proving the DB guard alone still holds the line.
//
// Covered:
//   • double clone prevention (lock + the transaction's status/version guard)
//   • preview deduplication (lock + the previewSentAt compare-and-set)
//   • no image jobs on reopen ("⬅️ Назад")
//   • assets deleted ONLY after a successful clone
//   • stale lock / retry safety (an expired lock lets the retry through)

import { Decimal } from '@prisma/client/runtime/library';
import { TelegramService } from './telegram.service';
import { WizardSessionStore, WizardStep } from './product-wizard';
import { makeFakeLock } from './draft-lock.test-util';
import { RedisKeys } from '../redis/redis.keys';
import { DraftLock } from '../redis/draft-lock.service';

type AnyService = TelegramService & Record<string, any>;

function draftRow(over: Record<string, unknown> = {}) {
  return {
    id: 'draft_1',
    sellerId: 1,
    tgId: BigInt(7),
    status: 'READY_FOR_PREVIEW',
    version: 3,
    previewSentAt: null,
    formStep: WizardStep.QUESTIONNAIRE_DONE,
    brand: 'Chevrolet',
    model: 'Nexia 3',
    category: 'SEDAN',
    title: 'Магнитола',
    description: null,
    partNumberType: 'UNKNOWN',
    partNumber: null,
    priceUzs: new Decimal(450000),
    images: [
      {
        id: 'dimg_1',
        sortOrder: 0,
        status: 'READY',
        stage: 'DONE',
        jobId: 'job_1',
        processedUrl: 'https://cdn/p1.jpg',
        processedPublicId: 'proc-1',
        originalPublicId: 'orig-1',
      },
    ],
    ...over,
  };
}

function makeService(over: Record<string, unknown> = {}): AnyService {
  const svc = Object.create(TelegramService.prototype) as AnyService;
  const cloudinaryDeleted: string[] = [];
  Object.assign(svc, {
    logger: { log() {}, warn() {}, error() {}, debug() {} },
    wizard: new WizardSessionStore(),
    pending: new Map(),
    sessionExpiry: new Map(),
    staleNoticeSentAt: new Map(),
    draftTtlMs: 24 * 60 * 60 * 1000,
    sellers: {
      findByTgId: jest.fn().mockResolvedValue({ id: 1, status: 'ACTIVE' }),
    },
    drafts: {},
    draftCoordinator: { onFormStep: jest.fn().mockResolvedValue(undefined) },
    queue: {
      enqueueImage: jest.fn().mockResolvedValue({ id: 'job_x' }),
      reenqueueImage: jest.fn().mockResolvedValue({ id: 'job_x' }),
      removeImageJob: jest.fn().mockResolvedValue(undefined),
    },
    cloudinary: {
      deleted: cloudinaryDeleted,
      deleteAssets: jest.fn(async (ids: string[]) => {
        cloudinaryDeleted.push(...ids);
      }),
    },
    telemetry: { event: jest.fn(), metric: jest.fn() },
    locks: makeFakeLock(),
    touchSession: jest.fn(),
    clearSessionExpiry: jest.fn(),
    sendStepPrompt: jest.fn().mockResolvedValue(undefined),
    sendPreviewToChat: jest.fn().mockResolvedValue(undefined),
    bot: {
      telegram: {
        sendMessage: jest.fn().mockResolvedValue(undefined),
        sendPhoto: jest.fn().mockResolvedValue(undefined),
        sendMediaGroup: jest.fn().mockResolvedValue(undefined),
      },
    },
    ...over,
  });
  return svc;
}

function makeCtx() {
  return { reply: jest.fn().mockResolvedValue(undefined) };
}

/** Seed the pending-preview record the "Назад" / "Изменить фото" taps consume. */
function seedPending(svc: AnyService, tgUserId = 7) {
  svc.pending.set(tgUserId, {
    sellerId: 1,
    tgUserId,
    draftId: 'draft_1',
    draftVersion: 4,
    metadata: {},
    title: 'Магнитола',
    vehicleCategory: 'SEDAN',
    processedUrls: ['https://cdn/p1.jpg'],
    publicIds: ['proc-1'],
    price: new Decimal(450000),
    expiry: setTimeout(() => {}, 0),
  });
}

describe('Draft flow — Redis coordination guards', () => {
  afterEach(() => jest.clearAllTimers());

  // ── Double clone prevention ───────────────────────────────────────────────
  describe('double clone prevention ("🖼 Изменить фото")', () => {
    it('clones once when two taps race: the second is skipped by the lock', async () => {
      const drafts = {
        findWithImages: jest.fn().mockResolvedValue(draftRow()),
        collectPublicIds: jest.fn().mockResolvedValue(['proc-1', 'orig-1']),
        cloneForPhotoReplacement: jest.fn().mockImplementation(
          () =>
            // Hold the "transaction" open so the second tap arrives mid-flight.
            new Promise((resolve) =>
              setImmediate(() =>
                resolve({ ...draftRow(), id: 'draft_new', status: 'CREATING' }),
              ),
            ),
        ),
      };
      const svc = makeService({ drafts });
      seedPending(svc);

      // Two concurrent taps. The first takes the lock; the second finds the
      // pending record gone AND/OR the lock held — either way it must not clone.
      await Promise.all([
        svc.replaceDraftPhotos(makeCtx(), 7),
        svc.replaceDraftPhotos(makeCtx(), 7),
      ]);

      expect(drafts.cloneForPhotoReplacement).toHaveBeenCalledTimes(1);
    });

    it('DB still wins when the lock fails open: the second clone is rejected by the transaction', async () => {
      // Redis is down — every acquire succeeds, so ONLY the DB guard protects us.
      const cloneForPhotoReplacement = jest
        .fn()
        // First tap commits; the second observes a no-longer-READY_FOR_PREVIEW
        // source (status+version guard inside the transaction) and returns null.
        .mockResolvedValueOnce({
          ...draftRow(),
          id: 'draft_new',
          status: 'CREATING',
        })
        .mockResolvedValueOnce(null);
      const drafts = {
        findWithImages: jest.fn().mockResolvedValue(draftRow()),
        collectPublicIds: jest.fn().mockResolvedValue(['proc-1', 'orig-1']),
        cloneForPhotoReplacement,
      };
      const svc = makeService({ drafts, locks: makeFakeLock({ failOpen: true }) });

      seedPending(svc);
      await svc.replaceDraftPhotos(makeCtx(), 7);
      seedPending(svc); // simulate the second tap still holding a preview record
      const ctx2 = makeCtx();
      await svc.replaceDraftPhotos(ctx2, 7);

      expect(cloneForPhotoReplacement).toHaveBeenCalledTimes(2);
      // Exactly ONE clone committed; the loser was told the listing moved on.
      expect(ctx2.reply).toHaveBeenCalledWith(
        expect.stringContaining('больше нельзя изменить'),
      );
      // And the loser deleted NOTHING (see the asset-ordering tests below).
      expect(svc.cloudinary.deleted).toEqual(['proc-1', 'orig-1']);
    });

    it('takes the clone lock keyed on the SOURCE draft', async () => {
      const drafts = {
        findWithImages: jest.fn().mockResolvedValue(draftRow()),
        collectPublicIds: jest.fn().mockResolvedValue([]),
        cloneForPhotoReplacement: jest
          .fn()
          .mockResolvedValue({ ...draftRow(), id: 'draft_new' }),
      };
      const svc = makeService({ drafts });
      seedPending(svc);

      await svc.replaceDraftPhotos(makeCtx(), 7);

      expect(svc.locks.acquired).toContain(RedisKeys.lockDraftClone('draft_1'));
    });
  });

  // ── Assets deleted only after a successful clone ──────────────────────────
  describe('assets are deleted ONLY after a successful clone', () => {
    it('does NOT delete assets when the clone transaction is rejected', async () => {
      const drafts = {
        findWithImages: jest.fn().mockResolvedValue(draftRow()),
        collectPublicIds: jest.fn().mockResolvedValue(['proc-1', 'orig-1']),
        // The source moved on (published/cancelled/swept) — no clone committed.
        cloneForPhotoReplacement: jest.fn().mockResolvedValue(null),
      };
      const svc = makeService({ drafts });
      seedPending(svc);
      const ctx = makeCtx();

      await svc.replaceDraftPhotos(ctx, 7);

      // The source still owns its images, so its assets MUST survive.
      expect(svc.cloudinary.deleteAssets).not.toHaveBeenCalled();
      expect(svc.cloudinary.deleted).toEqual([]);
      expect(svc.queue.removeImageJob).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('больше нельзя изменить'),
      );
    });

    it('deletes assets only AFTER the clone commits (strict ordering)', async () => {
      const order: string[] = [];
      const drafts = {
        findWithImages: jest.fn().mockResolvedValue(draftRow()),
        collectPublicIds: jest.fn().mockResolvedValue(['proc-1', 'orig-1']),
        cloneForPhotoReplacement: jest.fn(async () => {
          order.push('clone-commit');
          return { ...draftRow(), id: 'draft_new', status: 'CREATING' };
        }),
      };
      const svc = makeService({ drafts });
      svc.cloudinary.deleteAssets = jest.fn(async (ids: string[]) => {
        order.push('delete-assets');
        svc.cloudinary.deleted.push(...ids);
      });
      seedPending(svc);

      await svc.replaceDraftPhotos(makeCtx(), 7);

      expect(order).toEqual(['clone-commit', 'delete-assets']);
      expect(svc.cloudinary.deleted).toEqual(['proc-1', 'orig-1']);
    });

    it('collects the asset ids BEFORE the source is cancelled', async () => {
      const order: string[] = [];
      const drafts = {
        findWithImages: jest.fn().mockResolvedValue(draftRow()),
        collectPublicIds: jest.fn(async () => {
          order.push('collect');
          return ['proc-1'];
        }),
        cloneForPhotoReplacement: jest.fn(async () => {
          order.push('clone');
          return { ...draftRow(), id: 'draft_new' };
        }),
      };
      const svc = makeService({ drafts });
      seedPending(svc);

      await svc.replaceDraftPhotos(makeCtx(), 7);

      // The image rows go with the cancelled source, so ids must be read first.
      expect(order).toEqual(['collect', 'clone']);
    });
  });

  // ── Preview deduplication ─────────────────────────────────────────────────
  describe('preview deduplication', () => {
    it('sends once when the coordinator event and a /start recovery race', async () => {
      let claims = 0;
      const drafts = {
        findWithImages: jest.fn().mockResolvedValue(draftRow()),
        // The real CAS: only the first caller flips previewSentAt.
        claimPreviewSend: jest.fn(async () => ++claims === 1),
      };
      const svc = makeService({ drafts });

      await Promise.all([
        svc.presentDraftPreview('draft_1', 7),
        svc.presentDraftPreview('draft_1', 7),
      ]);

      expect(svc.sendPreviewToChat).toHaveBeenCalledTimes(1);
      expect(svc.pending.size).toBe(1); // storePending ran exactly once
    });

    it('DB still wins when the lock fails open: the CAS loser does not send', async () => {
      let claims = 0;
      const drafts = {
        findWithImages: jest.fn().mockResolvedValue(draftRow()),
        claimPreviewSend: jest.fn(async () => ++claims === 1),
      };
      const svc = makeService({
        drafts,
        locks: makeFakeLock({ failOpen: true }),
      });

      await svc.presentDraftPreview('draft_1', 7);
      await svc.presentDraftPreview('draft_1', 7);

      // Both reached the DB; only the claim winner delivered the album. This is
      // what stops a second storePending from deleting the winner's assets.
      expect(drafts.claimPreviewSend).toHaveBeenCalledTimes(2);
      expect(svc.sendPreviewToChat).toHaveBeenCalledTimes(1);
    });

    it('never sends without winning the claim, even holding the lock', async () => {
      const drafts = {
        findWithImages: jest.fn().mockResolvedValue(draftRow()),
        claimPreviewSend: jest.fn().mockResolvedValue(false), // already sent
      };
      const svc = makeService({ drafts });

      await svc.presentDraftPreview('draft_1', 7);

      expect(svc.sendPreviewToChat).not.toHaveBeenCalled();
      expect(svc.pending.size).toBe(0);
    });

    it('takes the preview lock keyed on the draft', async () => {
      const drafts = {
        findWithImages: jest.fn().mockResolvedValue(draftRow()),
        claimPreviewSend: jest.fn().mockResolvedValue(true),
      };
      const svc = makeService({ drafts });

      await svc.presentDraftPreview('draft_1', 7);

      expect(svc.locks.acquired).toContain(
        RedisKeys.lockDraftPreview('draft_1'),
      );
    });
  });

  // ── No jobs on reopen ─────────────────────────────────────────────────────
  describe('"⬅️ Назад" (reopen) creates NO image jobs', () => {
    it('reopens without touching the queue at all', async () => {
      const drafts = {
        reopenForEdit: jest.fn().mockResolvedValue(true),
        findWithImages: jest
          .fn()
          .mockResolvedValue(draftRow({ status: 'CREATING' })),
      };
      const svc = makeService({ drafts });
      seedPending(svc);

      await svc.reopenDraftForEdit(makeCtx(), 7);

      expect(drafts.reopenForEdit).toHaveBeenCalledTimes(1);
      // The whole point: READY images are REUSED, never re-processed.
      expect(svc.queue.enqueueImage).not.toHaveBeenCalled();
      expect(svc.queue.reenqueueImage).not.toHaveBeenCalled();
      expect(svc.queue.removeImageJob).not.toHaveBeenCalled();
      expect(svc.cloudinary.deleteAssets).not.toHaveBeenCalled();
    });

    it('creates no jobs when the lock fails open either', async () => {
      const drafts = {
        reopenForEdit: jest.fn().mockResolvedValue(true),
        findWithImages: jest
          .fn()
          .mockResolvedValue(draftRow({ status: 'CREATING' })),
      };
      const svc = makeService({
        drafts,
        locks: makeFakeLock({ failOpen: true }),
      });
      seedPending(svc);

      await svc.reopenDraftForEdit(makeCtx(), 7);

      expect(svc.queue.enqueueImage).not.toHaveBeenCalled();
      expect(svc.queue.reenqueueImage).not.toHaveBeenCalled();
    });

    it('creates no jobs when the reopen is REJECTED by the optimistic lock', async () => {
      const drafts = {
        reopenForEdit: jest.fn().mockResolvedValue(false), // draft moved on
        findWithImages: jest.fn(),
      };
      const svc = makeService({ drafts });
      seedPending(svc);
      const ctx = makeCtx();

      await svc.reopenDraftForEdit(ctx, 7);

      expect(svc.queue.enqueueImage).not.toHaveBeenCalled();
      expect(svc.queue.reenqueueImage).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('больше нельзя изменить'),
      );
    });

    it('reopens once under a double-tap and still creates no jobs', async () => {
      let calls = 0;
      const drafts = {
        // Versioned: only the first tap matches (expectedVersion).
        reopenForEdit: jest.fn(async () => ++calls === 1),
        findWithImages: jest
          .fn()
          .mockResolvedValue(draftRow({ status: 'CREATING' })),
      };
      const svc = makeService({ drafts });
      seedPending(svc);

      await Promise.all([
        svc.reopenDraftForEdit(makeCtx(), 7),
        svc.reopenDraftForEdit(makeCtx(), 7),
      ]);

      expect(drafts.reopenForEdit.mock.calls.length).toBeLessThanOrEqual(2);
      expect(svc.queue.enqueueImage).not.toHaveBeenCalled();
      expect(svc.queue.reenqueueImage).not.toHaveBeenCalled();
    });

    it('passes the observed version so the DB, not Redis, decides the winner', async () => {
      const drafts = {
        reopenForEdit: jest.fn().mockResolvedValue(true),
        findWithImages: jest
          .fn()
          .mockResolvedValue(draftRow({ status: 'CREATING' })),
      };
      const svc = makeService({ drafts });
      seedPending(svc);

      await svc.reopenDraftForEdit(makeCtx(), 7);

      expect(drafts.reopenForEdit).toHaveBeenCalledWith(
        'draft_1',
        4, // pending.draftVersion — the optimistic lock's expected version
        WizardStep.PRICE,
      );
      expect(svc.locks.acquired).toContain(RedisKeys.lockDraftReopen('draft_1'));
    });
  });

  // ── Image-enqueue guard + stale-lock retry safety ─────────────────────────
  describe('image job enqueue guard', () => {
    it('enqueues once per row and records the jobId', async () => {
      const drafts = { setImageJobId: jest.fn().mockResolvedValue(undefined) };
      const svc = makeService({ drafts });

      const jobId = await svc.enqueueImageJob('draft_1', 'dimg_1');

      expect(jobId).toBe('job_x');
      expect(svc.queue.enqueueImage).toHaveBeenCalledWith({
        draftId: 'draft_1',
        imageId: 'dimg_1',
      });
      expect(drafts.setImageJobId).toHaveBeenCalledWith('dimg_1', 'job_x');
      expect(svc.locks.acquired).toContain(
        RedisKeys.lockDraftImageEnqueue('draft_1', 'dimg_1'),
      );
    });

    it('skips a duplicate enqueue for the same row while one is in flight', async () => {
      const drafts = { setImageJobId: jest.fn().mockResolvedValue(undefined) };
      const svc = makeService({ drafts });
      // Another process already holds this row's lock.
      svc.locks.hold(RedisKeys.lockDraftImageEnqueue('draft_1', 'dimg_1'));

      const result = await svc.enqueueImageJob('draft_1', 'dimg_1');

      expect(result).toBeNull(); // skipped, not an error
      expect(svc.queue.enqueueImage).not.toHaveBeenCalled();
    });

    it('does not let one row block a DIFFERENT row', async () => {
      const drafts = { setImageJobId: jest.fn().mockResolvedValue(undefined) };
      const svc = makeService({ drafts });
      svc.locks.hold(RedisKeys.lockDraftImageEnqueue('draft_1', 'dimg_1'));

      expect(await svc.enqueueImageJob('draft_1', 'dimg_1')).toBeNull();
      expect(await svc.enqueueImageJob('draft_1', 'dimg_2')).toBe('job_x');
      expect(svc.queue.enqueueImage).toHaveBeenCalledTimes(1);
    });

    it("uses reenqueue for retries (a retained FAILED job's id would no-op)", async () => {
      const drafts = { setImageJobId: jest.fn().mockResolvedValue(undefined) };
      const svc = makeService({ drafts });

      await svc.enqueueImageJob('draft_1', 'dimg_1', 'reenqueue');

      expect(svc.queue.reenqueueImage).toHaveBeenCalledWith({
        draftId: 'draft_1',
        imageId: 'dimg_1',
      });
      expect(svc.queue.enqueueImage).not.toHaveBeenCalled();
    });

    it('releases the lock so a genuine retry can follow', async () => {
      const drafts = { setImageJobId: jest.fn().mockResolvedValue(undefined) };
      const svc = makeService({ drafts });

      await svc.enqueueImageJob('draft_1', 'dimg_1');
      await svc.enqueueImageJob('draft_1', 'dimg_1', 'reenqueue');

      expect(svc.queue.enqueueImage).toHaveBeenCalledTimes(1);
      expect(svc.queue.reenqueueImage).toHaveBeenCalledTimes(1);
    });

    it('requests the SHORT enqueue TTL, not the default sized for transactions', async () => {
      // This is the guard against the false-block scenario below: if this ever
      // regresses to DraftLock.DEFAULT_TTL_SECONDS, a crashed holder could shadow
      // a legitimate retry for up to 30s instead of a few seconds.
      const drafts = { setImageJobId: jest.fn().mockResolvedValue(undefined) };
      const svc = makeService({ drafts });

      await svc.enqueueImageJob('draft_1', 'dimg_1');

      expect(svc.locks.ttlsRequested).toEqual([DraftLock.ENQUEUE_TTL_SECONDS]);
    });
  });

  // ── Stale lock / retry safety ─────────────────────────────────────────────
  describe('stale lock / retry safety', () => {
    it('a lock left behind by a crashed holder stops blocking once it expires', async () => {
      const drafts = { setImageJobId: jest.fn().mockResolvedValue(undefined) };
      const svc = makeService({ drafts });
      const key = RedisKeys.lockDraftImageEnqueue('draft_1', 'dimg_1');

      svc.locks.hold(key); // holder crashed mid-enqueue, never released
      expect(await svc.enqueueImageJob('draft_1', 'dimg_1')).toBeNull();

      svc.locks.expire(key); // Redis TTL elapses — this is the self-healing part

      expect(await svc.enqueueImageJob('draft_1', 'dimg_1')).toBe('job_x');
      expect(svc.queue.enqueueImage).toHaveBeenCalledTimes(1);
    });

    it('a real seller retry after a worker crash is not shadowed by the dead lock', async () => {
      // The exact sequence the short ENQUEUE_TTL exists for: a worker dies
      // mid-enqueue and never releases the lock on (draft_1, dimg_1). The row is
      // left FAILED in Postgres. The seller taps "🔁 Повторить" — retryFailedImages
      // calls resetFailedImages (DB: FAILED → PROCESSING, the real state change)
      // and IMMEDIATELY reenqueues. If the enqueue lock's TTL were long (e.g. the
      // 30s default), this retry would be silently skipped as a "duplicate" of a
      // holder that will never finish — even though `reenqueueImage` is
      // independently idempotent and there is nothing left to collide with.
      const drafts = {
        setImageJobId: jest.fn().mockResolvedValue(undefined),
        resetFailedImages: jest
          .fn()
          .mockResolvedValue([{ id: 'dimg_1', status: 'PROCESSING' }]),
      };
      const svc = makeService({ drafts });
      const key = RedisKeys.lockDraftImageEnqueue('draft_1', 'dimg_1');
      svc.locks.hold(key); // the crashed worker's lock, never released

      // Immediately after resetFailedImages flips the DB row, the retry handler
      // reenqueues — while the stale lock is (for now) still "held".
      const duringCrashWindow = await svc.enqueueImageJob(
        'draft_1',
        'dimg_1',
        'reenqueue',
      );
      expect(duringCrashWindow).toBeNull(); // momentarily shadowed — expected

      // Because ENQUEUE_TTL_SECONDS is short, the shadow clears fast. Simulate
      // that TTL elapsing (not a fresh `hold`, which would be a different lock
      // acquisition — this is Redis expiring the SAME dead key on its own).
      svc.locks.expire(key);

      // The seller's retry now goes through — this is the assertion that
      // matters: a short TTL turns "silently stuck until 30s pass" into "goes
      // through on the very next attempt".
      const afterExpiry = await svc.enqueueImageJob('draft_1', 'dimg_1', 'reenqueue');
      expect(afterExpiry).toBe('job_x');
      expect(svc.queue.reenqueueImage).toHaveBeenCalledWith({
        draftId: 'draft_1',
        imageId: 'dimg_1',
      });
    });

    it('a stale clone lock does not permanently block photo replacement', async () => {
      const drafts = {
        findWithImages: jest.fn().mockResolvedValue(draftRow()),
        collectPublicIds: jest.fn().mockResolvedValue(['proc-1']),
        cloneForPhotoReplacement: jest
          .fn()
          .mockResolvedValue({ ...draftRow(), id: 'draft_new' }),
      };
      const svc = makeService({ drafts });
      const key = RedisKeys.lockDraftClone('draft_1');

      svc.locks.hold(key);
      seedPending(svc);
      await svc.replaceDraftPhotos(makeCtx(), 7);
      expect(drafts.cloneForPhotoReplacement).not.toHaveBeenCalled();

      svc.locks.expire(key); // TTL elapsed
      seedPending(svc);
      await svc.replaceDraftPhotos(makeCtx(), 7);

      expect(drafts.cloneForPhotoReplacement).toHaveBeenCalledTimes(1);
    });

    it('a crashed preview holder does not strand the draft (retry re-claims)', async () => {
      const drafts = {
        findWithImages: jest.fn().mockResolvedValue(draftRow()),
        claimPreviewSend: jest.fn().mockResolvedValue(true),
      };
      const svc = makeService({ drafts });
      const key = RedisKeys.lockDraftPreview('draft_1');

      svc.locks.hold(key);
      await svc.presentDraftPreview('draft_1', 7);
      expect(svc.sendPreviewToChat).not.toHaveBeenCalled();

      svc.locks.expire(key);
      await svc.presentDraftPreview('draft_1', 7);

      // The recovery path (/start) delivers the preview that the crash lost.
      expect(svc.sendPreviewToChat).toHaveBeenCalledTimes(1);
    });

    it('a lock is released after the guarded body throws (no wedge)', async () => {
      const drafts = {
        setImageJobId: jest.fn().mockResolvedValue(undefined),
      };
      const svc = makeService({ drafts });
      svc.queue.enqueueImage = jest
        .fn()
        .mockRejectedValueOnce(new Error('queue down'))
        .mockResolvedValue({ id: 'job_x' });

      await expect(svc.enqueueImageJob('draft_1', 'dimg_1')).rejects.toThrow(
        'queue down',
      );
      // The failed attempt must not leave the row locked forever.
      expect(await svc.enqueueImageJob('draft_1', 'dimg_1')).toBe('job_x');
    });
  });
});
