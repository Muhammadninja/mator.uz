// Two runs of the SAME image job at once — what BullMQ produces when a job's
// lock is lost (Redis unreachable during a long FLUX call) and the stalled-job
// check starts it again while the first run is still going.
//
// The REAL ProductDraftService runs over an in-memory row store whose
// updateMany checks its WHERE and writes in one step — how PostgreSQL
// serializes two UPDATEs of one row (the second re-checks its WHERE against
// the first one's committed row). FLUX is held behind a barrier, so both runs
// are genuinely in flight together, not one after the other. No DB, Redis,
// Cloudinary, FLUX or Telegram is reached.

import axios from 'axios';
import { UnrecoverableError, type Job } from 'bullmq';
import { DraftImageStatus, ImageProcessingStage, Prisma } from '@prisma/client';
import { ProductDraftService } from '../telegram/product-draft.service';
import { ImageProcessingProcessor } from './queue.processors';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

type Row = {
  id: string;
  draftId: string;
  tgFileId: string;
  status: DraftImageStatus;
  stage: ImageProcessingStage;
  attempts: number;
  originalUrl: string | null;
  originalPublicId: string | null;
  processedUrl: string | null;
  processedPublicId: string | null;
  lastError: string | null;
};

/** The subset of Prisma's where-language the image writes use. */
function matches(row: Row, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'NOT') return !matches(row, cond);
    const value = (row as Record<string, unknown>)[key];
    if (cond !== null && typeof cond === 'object' && 'not' in cond) {
      return value !== cond.not;
    }
    return value === cond;
  });
}

/** Apply a Prisma `data` object to the row, `{ increment }` included. */
function apply(row: Row, data: Record<string, any>): void {
  for (const [k, v] of Object.entries(data)) {
    (row as Record<string, unknown>)[k] =
      v !== null && typeof v === 'object' && 'increment' in v
        ? (row as unknown as Record<string, number>)[k] + v.increment
        : v;
  }
}

function rowStore(initial: Partial<Row> = {}) {
  const row: Row = {
    id: 'img_1',
    draftId: 'draft_1',
    tgFileId: 'tg_file_1',
    status: DraftImageStatus.PROCESSING,
    stage: ImageProcessingStage.QUEUED,
    attempts: 0,
    originalUrl: null,
    originalPublicId: null,
    processedUrl: null,
    processedPublicId: null,
    lastError: null,
    ...initial,
  };
  const writes: { where: unknown; data: Record<string, any> }[] = [];
  const productDraftImage = {
    // Check and write in ONE synchronous step: atomic, like a row UPDATE.
    updateMany: jest.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, any>;
        data: Record<string, any>;
      }) => {
        await Promise.resolve(); // a DB round trip: the other run may interleave
        if (!matches(row, where)) return { count: 0 };
        writes.push({ where, data });
        apply(row, data);
        return { count: 1 };
      },
    ),
    findUnique: jest.fn(
      async ({
        where,
        select,
      }: {
        where: { id: string };
        select?: Record<string, boolean>;
      }) => {
        await Promise.resolve();
        if (where.id !== row.id) return null;
        if (!select) return { ...row };
        return Object.fromEntries(
          Object.keys(select).map((k) => [
            k,
            (row as Record<string, unknown>)[k],
          ]),
        );
      },
    ),
    findMany: jest.fn(({ where }: { where: Record<string, any> }) =>
      Promise.resolve(matches(row, where) ? [{ ...row }] : []),
    ),
    // Only the pickup uses update: UPDATE … WHERE … RETURNING, P2025 on no match.
    update: jest.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, any>;
        data: Record<string, any>;
      }) => {
        await Promise.resolve();
        if (!matches(row, where)) {
          throw new Prisma.PrismaClientKnownRequestError(
            'No record was found for an update.',
            { code: 'P2025', clientVersion: 'test' },
          );
        }
        writes.push({ where, data });
        apply(row, data);
        return { ...row };
      },
    ),
  };
  return { row, writes, prisma: { productDraftImage } };
}

/** FLUX that answers only once `parties` calls are in flight together. */
function fluxBarrier(parties: number) {
  let waiting: (() => void)[] = [];
  let n = 0;
  const removeBackground = jest.fn(
    () =>
      new Promise<Buffer>((resolve) => {
        n += 1;
        waiting.push(() => resolve(Buffer.from(`cleaned-${n}`)));
        if (waiting.length >= parties) {
          const release = waiting;
          waiting = [];
          release.forEach((go) => go());
        }
      }),
  );
  return { removeBackground };
}

function worker(
  drafts: ProductDraftService,
  shared: {
    flux: { removeBackground: jest.Mock };
    cloudinary: { uploadBuffer: jest.Mock; deleteAssets: jest.Mock };
    coordinator: { onImageSettled: jest.Mock };
    telemetry: { event: jest.Mock; metric: jest.Mock };
  },
) {
  const proc = new ImageProcessingProcessor(
    drafts,
    shared.coordinator as never,
    shared.cloudinary as never,
    {
      getFileUrl: jest.fn().mockResolvedValue('https://tg.example/file'),
    } as never,
    shared.flux as never,
    shared.telemetry as never,
  );
  const logger = (proc as never as { logger: Record<string, unknown> }).logger;
  logger.log = () => undefined;
  logger.warn = () => undefined;
  logger.error = () => undefined;
  return proc;
}

function setup(initial: Partial<Row> = {}, parties = 2) {
  const store = rowStore(initial);
  const drafts = new ProductDraftService(store.prisma as never);
  let uploads = 0;
  const shared = {
    flux: fluxBarrier(parties),
    cloudinary: {
      // Cloudinary gives every upload a fresh public_id.
      uploadBuffer: jest.fn(async () => {
        await Promise.resolve(); // an upload round trip
        uploads += 1;
        return {
          url: `https://res.example/asset_${uploads}.png`,
          publicId: `asset_${uploads}`,
        };
      }),
      deleteAssets: jest.fn().mockResolvedValue(undefined),
    },
    coordinator: { onImageSettled: jest.fn().mockResolvedValue(undefined) },
    telemetry: { event: jest.fn(), metric: jest.fn() },
  };
  return {
    ...store,
    drafts,
    ...shared,
    shared,
    worker: () => worker(drafts, shared),
  };
}

const job = {
  id: 'image_draft_1_img_1',
  data: { draftId: 'draft_1', imageId: 'img_1' },
} as unknown as Job;

const events = (t: { event: jest.Mock }) =>
  t.event.mock.calls.map((c) => c[0] as string);
const deleted = (c: { deleteAssets: jest.Mock }) =>
  c.deleteAssets.mock.calls.flatMap((c) => c[0] as string[]);

beforeEach(() => {
  jest.clearAllMocks();
  mockedAxios.get.mockResolvedValue({ data: new ArrayBuffer(4) });
});

describe('image finalization with one worker', () => {
  it('1. finalizes READY with its result and settles once', async () => {
    const t = setup({}, 1);
    await expect(t.worker().process(job)).resolves.toBeUndefined();
    expect(t.row).toMatchObject({
      status: 'READY',
      stage: 'DONE',
      originalPublicId: 'asset_1',
      processedUrl: 'https://res.example/asset_2.png',
      processedPublicId: 'asset_2',
      attempts: 1,
    });
    expect(t.coordinator.onImageSettled).toHaveBeenCalledTimes(1);
    expect(t.cloudinary.deleteAssets).not.toHaveBeenCalled();
    // update is the pickup alone (UPDATE … RETURNING); every other write is a
    // conditional updateMany.
    expect(t.prisma.productDraftImage.update).toHaveBeenCalledTimes(1);
  });
});

describe('two workers on one image at once', () => {
  it('2–5. both complete, exactly one result is written, settled once, the loser drops only its own uploads', async () => {
    const t = setup();
    const [a, b] = [t.worker(), t.worker()];

    const results = await Promise.all([a.process(job), b.process(job)]);

    // 2. Both finish successfully (no retry): one finalizes, one lost.
    expect(results.sort()).toEqual(
      [undefined, { skipped: 'lost_race' }].sort(),
    );
    expect(t.flux.removeBackground).toHaveBeenCalledTimes(2); // both truly ran FLUX
    // Exactly one READY write ever happened.
    const readyWrites = t.writes.filter((w) => w.data.status === 'READY');
    expect(readyWrites).toHaveLength(1);
    // 3. The winner settles the draft exactly once.
    expect(t.coordinator.onImageSettled).toHaveBeenCalledTimes(1);
    // 4. The stored result is the winner's — never replaced by the loser's.
    expect(t.row.processedUrl).toBe(readyWrites[0].data.processedUrl);
    expect(t.row.processedPublicId).toBe(readyWrites[0].data.processedPublicId);
    expect(t.row).toMatchObject({ status: 'READY', stage: 'DONE' });
    // 5. Four uploads (2 originals, 2 results); the loser's surplus original
    //    and result are deleted — never an asset the row uses.
    expect(t.cloudinary.uploadBuffer).toHaveBeenCalledTimes(4);
    const gone = deleted(t.cloudinary);
    expect(gone).toHaveLength(2);
    expect(gone).not.toContain(t.row.processedPublicId);
    expect(gone).not.toContain(t.row.originalPublicId);
    expect(
      new Set([...gone, t.row.processedPublicId, t.row.originalPublicId]).size,
    ).toBe(4);
    expect(events(t.telemetry)).toEqual(
      expect.arrayContaining([
        'image.finalize_lost',
        'image.surplus_original_deleted',
        'image.surplus_processed_deleted',
      ]),
    );
  });

  it('both runs enhance the ONE stored original, not their own', async () => {
    const t = setup();
    await Promise.all([t.worker().process(job), t.worker().process(job)]);
    const enhancedFrom = mockedAxios.get.mock.calls
      .map((c) => c[0])
      .filter((url) => url !== 'https://tg.example/file');
    expect(enhancedFrom).toEqual([t.row.originalUrl, t.row.originalUrl]);
    expect(t.writes.filter((w) => 'originalUrl' in w.data)).toHaveLength(1);
  });

  it('6. a failed cleanup does not fail the job into a retry — FLUX is not run again', async () => {
    const t = setup();
    t.cloudinary.deleteAssets.mockRejectedValue(new Error('Cloudinary 500'));

    const results = await Promise.all([
      t.worker().process(job),
      t.worker().process(job),
    ]);

    expect(results).toContainEqual({ skipped: 'lost_race' });
    expect(t.flux.removeBackground).toHaveBeenCalledTimes(2); // once per run, never again
    expect(events(t.telemetry)).toContain('image.surplus_processed_kept');
    expect(t.row.status).toBe('READY');
  });

  it('keeps the surplus asset (and reports it) when the row cannot be read to prove it unused', async () => {
    const t = setup({
      originalUrl: 'https://res.example/orig.png',
      originalPublicId: 'orig',
    });
    const realFind =
      t.prisma.productDraftImage.findUnique.getMockImplementation()!;
    let reads = 0;
    t.prisma.productDraftImage.findUnique.mockImplementation(
      async (args: any) => {
        // The loser's post-race read fails; the guard reads before it succeed.
        if (args.select && ++reads > 2) throw new Error('connection reset');
        return realFind(args);
      },
    );

    const results = await Promise.all([
      t.worker().process(job),
      t.worker().process(job),
    ]);

    expect(results).toContainEqual({ skipped: 'lost_race' });
    expect(t.cloudinary.deleteAssets).not.toHaveBeenCalled();
    expect(events(t.telemetry)).toContain('image.surplus_processed_kept');
  });
});

describe('states the row may move to during processing', () => {
  it('7. a row that turned FAILED meanwhile is not overwritten, not settled, and the upload is dropped', async () => {
    const t = setup({}, 1);
    t.flux.removeBackground.mockImplementation(async () => {
      // A newer run took the row over and failed with ITS token.
      const newer = await t.drafts.markImageProcessing('img_1');
      await t.drafts.markImageFailed('img_1', 'FLUX 500', newer!.attempts);
      return Buffer.from('cleaned');
    });

    await expect(t.worker().process(job)).resolves.toEqual({
      skipped: 'lost_race',
    });
    expect(t.row).toMatchObject({
      status: 'FAILED',
      stage: 'FAILED',
      processedUrl: null,
      lastError: 'FLUX 500',
    });
    expect(t.coordinator.onImageSettled).not.toHaveBeenCalled();
    expect(deleted(t.cloudinary)).toEqual(['asset_2']);
  });

  it("a failing run never turns the winner's READY into FAILED, nor settles again", async () => {
    const t = setup({
      status: 'READY',
      stage: 'DONE',
      processedUrl: 'https://res.example/p.png',
      processedPublicId: 'p',
    });
    const proc = t.worker();
    await proc.onFailed(
      { ...job, opts: { attempts: 3 }, attemptsMade: 3 } as never,
      new Error('FLUX 500'),
    );
    expect(t.row).toMatchObject({
      status: 'READY',
      stage: 'DONE',
      processedUrl: 'https://res.example/p.png',
    });
    expect(t.coordinator.onImageSettled).not.toHaveBeenCalled();
  });

  it("a lagging run's stage write does not undo DONE on a READY row", async () => {
    const t = setup({
      status: 'READY',
      stage: 'DONE',
      processedUrl: 'https://res.example/p.png',
    });
    await t.drafts.setImageStage(
      'img_1',
      ImageProcessingStage.UPLOADING_RESULT,
      t.row.attempts,
    );
    expect(t.row.stage).toBe('DONE');
  });

  it("stops before FLUX when the other run already finished during this one's ingest", async () => {
    const t = setup({}, 1);
    const proc = t.worker();
    t.cloudinary.uploadBuffer.mockImplementationOnce(async () => {
      await Promise.resolve();
      // The other run stores its original and finalizes while ours uploads.
      Object.assign(t.row, {
        originalUrl: 'https://res.example/other-orig.png',
        originalPublicId: 'other_orig',
        status: 'READY',
        stage: 'DONE',
        processedUrl: 'https://res.example/other.png',
        processedPublicId: 'other',
      });
      return { url: 'https://res.example/mine.png', publicId: 'mine' };
    });

    await expect(proc.process(job)).resolves.toEqual({
      skipped: 'already_ready',
    });
    expect(t.flux.removeBackground).not.toHaveBeenCalled();
    expect(deleted(t.cloudinary)).toEqual(['mine']);
    expect(t.row.processedPublicId).toBe('other');
  });
});

describe('existing behaviour kept', () => {
  it('8. a FAILED image retried by the seller is processed again and finalized', async () => {
    const t = setup(
      {
        status: 'FAILED',
        stage: 'FAILED',
        lastError: 'FLUX 500',
        originalUrl: 'https://res.example/o.png',
        originalPublicId: 'o',
      },
      1,
    );
    // "🔁 Повторить": the row is reset to PROCESSING before the job is re-enqueued.
    await t.drafts.resetFailedImages('draft_1');
    expect(t.row).toMatchObject({
      status: 'PROCESSING',
      stage: 'QUEUED',
      lastError: null,
    });

    await expect(t.worker().process(job)).resolves.toBeUndefined();
    expect(t.row).toMatchObject({
      status: 'READY',
      stage: 'DONE',
      processedPublicId: 'asset_1',
      originalPublicId: 'o',
    });
    expect(t.coordinator.onImageSettled).toHaveBeenCalledTimes(1);
  });

  it('9. the READY guard still skips a duplicate job without any write', async () => {
    const t = setup(
      {
        status: 'READY',
        stage: 'DONE',
        processedUrl: 'https://res.example/p.png',
        processedPublicId: 'p',
      },
      1,
    );
    await expect(t.worker().process(job)).resolves.toEqual({
      skipped: 'already_ready',
    });
    expect(t.writes).toHaveLength(0);
    expect(t.flux.removeBackground).not.toHaveBeenCalled();
    expect(t.cloudinary.uploadBuffer).not.toHaveBeenCalled();
  });

  it('a row stuck PROCESSING (recovery re-enqueue) is processed normally', async () => {
    const t = setup(
      {
        stage: 'ENHANCING',
        attempts: 2,
        originalUrl: 'https://res.example/o.png',
        originalPublicId: 'o',
      },
      1,
    );
    await t.worker().process(job);
    expect(t.row).toMatchObject({
      status: 'READY',
      attempts: 3,
      originalPublicId: 'o',
    });
  });

  it('a missing row still fails the job, as before', async () => {
    const t = setup({}, 1);
    t.row.id = 'gone';
    await expect(t.worker().process(job)).rejects.toThrow(
      'Image row img_1 not found',
    );
  });
});

// ── Execution ownership: interleavings where BOTH runs are PROCESSING ──────

/** FLUX whose every call the test answers by hand, in any order. */
function heldFlux() {
  const calls: { resolve: (b: Buffer) => void; reject: (e: Error) => void }[] =
    [];
  const removeBackground = jest.fn(
    () =>
      new Promise<Buffer>((resolve, reject) => calls.push({ resolve, reject })),
  );
  return { removeBackground, calls };
}

async function until(condition: () => boolean, what: string) {
  for (let i = 0; i < 1_000 && !condition(); i++) {
    await new Promise((r) => setImmediate(r));
  }
  if (!condition()) throw new Error(`never reached: ${what}`);
}

/** A (claimed first) and B (claimed second, so the owner) both in FLUX. */
async function bothInFlux() {
  const t = setup({
    originalUrl: 'https://res.example/o.png',
    originalPublicId: 'o',
  });
  const flux = heldFlux();
  t.shared.flux = flux;
  const [a, b] = [t.worker(), t.worker()];
  const runA = a.process(job);
  await until(() => flux.calls.length === 1, 'A in FLUX');
  const ownerA = t.row.attempts;
  const runB = b.process(job);
  await until(() => flux.calls.length === 2, 'B in FLUX');
  const ownerB = t.row.attempts;
  return { t, flux, a, b, runA, runB, ownerA, ownerB };
}

const finalAttempt = {
  ...job,
  attemptsMade: 3,
  opts: { attempts: 3 },
} as never;

describe('execution ownership (fencing on attempts)', () => {
  it('A and B are both PROCESSING; B, the later pickup, owns the row', async () => {
    const { t, flux, runA, runB, ownerA, ownerB } = await bothInFlux();
    expect(t.row.status).toBe('PROCESSING');
    expect([ownerA, ownerB]).toEqual([1, 2]);
    flux.calls.forEach((c) => c.resolve(Buffer.from('x')));
    await Promise.all([runA, runB]);
  });

  it('A fails, B succeeds: A cannot mark the row FAILED, B finalizes READY and settles once', async () => {
    const { t, flux, a, runA, runB } = await bothInFlux();

    flux.calls[0].reject(new Error('FLUX 502'));
    const errA = await runA.catch((e: Error) => e);
    expect(errA).toBeInstanceOf(Error);
    // BullMQ's final 'failed' event for A's run.
    await a.onFailed(finalAttempt, errA as Error);
    expect(t.row).toMatchObject({ status: 'PROCESSING', lastError: null });
    expect(t.coordinator.onImageSettled).not.toHaveBeenCalled();

    flux.calls[1].resolve(Buffer.from('cleaned-b'));
    await expect(runB).resolves.toBeUndefined();
    expect(t.row).toMatchObject({ status: 'READY', stage: 'DONE' });
    // A failed before uploading anything: the only result upload is B's.
    expect(t.cloudinary.uploadBuffer).toHaveBeenCalledTimes(1);
    const bResult = (await t.cloudinary.uploadBuffer.mock.results[0].value) as {
      publicId: string;
    };
    expect(t.row.processedPublicId).toBe(bResult.publicId);
    expect(t.coordinator.onImageSettled).toHaveBeenCalledTimes(1);
  });

  it("A finishing first can neither move B's stage nor finalize; only B, the owner, can", async () => {
    const { t, flux, runA, runB } = await bothInFlux();
    expect(t.row.stage).toBe('ENHANCING'); // B's

    flux.calls[0].resolve(Buffer.from('cleaned-a'));
    await expect(runA).resolves.toEqual({ skipped: 'lost_race' });
    // A's UPLOADING_RESULT and READY were both refused: the row is B's, as B left it.
    expect(t.row).toMatchObject({
      status: 'PROCESSING',
      stage: 'ENHANCING',
      processedUrl: null,
    });
    expect(t.coordinator.onImageSettled).not.toHaveBeenCalled();
    const aResult = (await t.cloudinary.uploadBuffer.mock.results[0].value) as {
      publicId: string;
    };
    expect(deleted(t.cloudinary)).toEqual([aResult.publicId]); // only A's own upload

    flux.calls[1].resolve(Buffer.from('cleaned-b'));
    await expect(runB).resolves.toBeUndefined();
    expect(t.row.status).toBe('READY');
    expect(t.row.processedPublicId).not.toBe(aResult.publicId);
    expect(t.coordinator.onImageSettled).toHaveBeenCalledTimes(1);
  });

  it("a superseded run's late stage write changes nothing", async () => {
    const t = setup({ stage: 'ENHANCING', attempts: 2 });
    await t.drafts.setImageStage(
      'img_1',
      ImageProcessingStage.UPLOADING_RESULT,
      1,
    );
    expect(t.row.stage).toBe('ENHANCING');
    await t.drafts.setImageStage(
      'img_1',
      ImageProcessingStage.UPLOADING_RESULT,
      2,
    );
    expect(t.row.stage).toBe('UPLOADING_RESULT');
  });

  it("the owner's own final failure still marks FAILED and settles", async () => {
    const t = setup(
      { originalUrl: 'https://res.example/o.png', originalPublicId: 'o' },
      1,
    );
    t.flux.removeBackground.mockRejectedValue(new Error('FLUX 502'));
    const proc = t.worker();
    const err = await proc.process(job).catch((e: Error) => e);
    await proc.onFailed(finalAttempt, err as Error);
    expect(t.row).toMatchObject({
      status: 'FAILED',
      stage: 'FAILED',
      lastError: 'FLUX 502',
    });
    expect(t.coordinator.onImageSettled).toHaveBeenCalledTimes(1);
  });

  it("a run whose pickup failed has no token: its late error leaves B's row alone", async () => {
    const t = setup({ attempts: 0 });
    const proc = t.worker();
    // A reads the row… then B claims it (token 1)… then A's own pickup fails.
    const realUpdate =
      t.prisma.productDraftImage.update.getMockImplementation()!;
    t.prisma.productDraftImage.update.mockImplementationOnce(
      async (args: any) => {
        await realUpdate(args); // B's pickup
        throw new Error('connection reset'); // A's
      },
    );
    const err = await proc.process(job).catch((e: Error) => e);
    expect(t.row.attempts).toBe(1);
    await proc.onFailed(finalAttempt, err as Error);
    expect(t.row.status).toBe('PROCESSING'); // B's run is untouched
    expect(t.coordinator.onImageSettled).not.toHaveBeenCalled();
  });
});

describe('no ownership token, no write', () => {
  it("A cannot read the row, B gets the token, A's late error cannot change B's row", async () => {
    const t = setup({
      originalUrl: 'https://res.example/o.png',
      originalPublicId: 'o',
    });
    const flux = heldFlux();
    t.shared.flux = flux;
    const [a, b] = [t.worker(), t.worker()];
    // A's very first read fails: A never gets as far as the pickup.
    const realFind =
      t.prisma.productDraftImage.findUnique.getMockImplementation()!;
    t.prisma.productDraftImage.findUnique.mockImplementationOnce(() =>
      Promise.reject(new Error('connection reset')),
    );
    const errA = await a.process(job).catch((e: Error) => e);
    expect(errA).toBeInstanceOf(Error);
    t.prisma.productDraftImage.findUnique.mockImplementation(realFind);

    // B takes the row (token 1) and is mid-run, in FLUX.
    const runB = b.process(job);
    await until(() => flux.calls.length === 1, 'B in FLUX');
    const before = { ...t.row };
    expect(before).toMatchObject({
      status: 'PROCESSING',
      stage: 'ENHANCING',
      attempts: 1,
    });

    // BullMQ reports A's failure as final: nothing changes.
    await a.onFailed(finalAttempt, errA as Error);
    expect(t.row).toEqual(before);
    expect(t.coordinator.onImageSettled).not.toHaveBeenCalled();
    expect(events(t.telemetry)).toContain('image.failure_unowned');

    // B finishes and owns the outcome.
    flux.calls[0].resolve(Buffer.from('cleaned-b'));
    await expect(runB).resolves.toBeUndefined();
    expect(t.row).toMatchObject({ status: 'READY', stage: 'DONE' });
    expect(t.coordinator.onImageSettled).toHaveBeenCalledTimes(1);
  });

  it('a job BullMQ fails as stalled past the limit changes nothing: the row stays for recovery', async () => {
    // BullMQ 5.81: the next worker to fetch such a job fails it at once with
    // this UnrecoverableError — no process() run, so no token.
    const t = setup({ stage: 'ENHANCING', attempts: 2 });
    const proc = t.worker();
    const before = { ...t.row };
    await proc.onFailed(
      finalAttempt,
      new UnrecoverableError('job stalled more than allowable limit'),
    );
    expect(t.row).toEqual(before);
    expect(t.coordinator.onImageSettled).not.toHaveBeenCalled();
  });

  it('a superseded run cannot write READY, FAILED or a stage with its old token', async () => {
    const t = setup({ stage: 'ENHANCING', attempts: 2 });
    const before = { ...t.row };
    await t.drafts.setImageStage(
      'img_1',
      ImageProcessingStage.UPLOADING_RESULT,
      1,
    );
    expect(await t.drafts.markImageFailed('img_1', 'late', 1)).toBe(false);
    expect(await t.drafts.markImageReady('img_1', 'https://x', 'x', 1)).toBe(
      false,
    );
    expect(t.row).toEqual(before);
  });
});
