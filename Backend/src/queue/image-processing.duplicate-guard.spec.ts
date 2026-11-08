// The image worker's duplicate-job guard. A job for a row that is already
// READY with a result completes as skipped and touches nothing — no DB write,
// no FLUX, no Cloudinary, no new processedUrl. Every other state keeps the
// existing processing path (a FAILED row's retry included). All collaborators
// are mocked: no Telegram, no Cloudinary, no FLUX, no DB, no Redis.

import axios from 'axios';
import type { Job } from 'bullmq';
import { ImageProcessingProcessor } from './queue.processors';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

function build(state: { status: string; processedUrl: string | null } | null) {
  const drafts = {
    findImageState: jest.fn().mockResolvedValue(state),
    markImageProcessing: jest.fn().mockResolvedValue({
      attempts: 1,
      id: 'img_1',
      tgFileId: 'tg_file',
      originalUrl: 'https://res.cloudinary.example/original.jpg',
    }),
    setImageStage: jest.fn().mockResolvedValue(undefined),
    setImageOriginal: jest.fn().mockResolvedValue(true),
    markImageReady: jest.fn().mockResolvedValue(true),
    markImageFailed: jest.fn().mockResolvedValue(true),
  };
  const coordinator = {
    onImageSettled: jest.fn().mockResolvedValue(undefined),
  };
  const cloudinary = {
    uploadBuffer: jest
      .fn()
      .mockResolvedValue({ url: 'https://new', publicId: 'new' }),
  };
  const telegramFiles = { getFileUrl: jest.fn() };
  const imageEnhance = {
    removeBackground: jest.fn().mockResolvedValue(Buffer.from('cleaned')),
  };
  const telemetry = { event: jest.fn(), metric: jest.fn() };
  const metrics = { observeJob: jest.fn(), observeImageProcessing: jest.fn() };
  const proc = new ImageProcessingProcessor(
    drafts as never,
    coordinator as never,
    cloudinary as never,
    telegramFiles as never,
    imageEnhance as never,
    telemetry as never,
    metrics as never,
  );
  const logs: string[] = [];
  const logger = (proc as never as { logger: Record<string, unknown> }).logger;
  logger.log = (m: string) => logs.push(m);
  logger.error = () => undefined;
  return {
    proc,
    drafts,
    coordinator,
    cloudinary,
    telegramFiles,
    imageEnhance,
    telemetry,
    metrics,
    logs,
  };
}

const job = (id = 'image_draft_1_img_1') =>
  ({
    id,
    data: { draftId: 'draft_1', imageId: 'img_1' },
    attemptsMade: 0,
    opts: { attempts: 3 },
    processedOn: 1_000,
    finishedOn: 3_000,
  }) as unknown as Job;

beforeEach(() => {
  jest.clearAllMocks();
  mockedAxios.get.mockResolvedValue({ data: new ArrayBuffer(4) });
});

describe('ImageProcessingProcessor duplicate guard', () => {
  it('skips a job whose row is already READY with a result — and touches nothing', async () => {
    const ctx = build({
      status: 'READY',
      processedUrl: 'https://res.cloudinary.example/done.png',
    });

    const result = await ctx.proc.process(job());

    expect(result).toEqual({ skipped: 'already_ready' });
    expect(ctx.drafts.findImageState).toHaveBeenCalledWith('img_1');
    // No write of any kind, no FLUX, no download, no upload, no new processedUrl.
    for (const write of [
      ctx.drafts.markImageProcessing,
      ctx.drafts.setImageStage,
      ctx.drafts.setImageOriginal,
      ctx.drafts.markImageReady,
      ctx.drafts.markImageFailed,
    ]) {
      expect(write).not.toHaveBeenCalled();
    }
    expect(ctx.imageEnhance.removeBackground).not.toHaveBeenCalled();
    expect(ctx.cloudinary.uploadBuffer).not.toHaveBeenCalled();
    expect(ctx.telegramFiles.getFileUrl).not.toHaveBeenCalled();
    expect(mockedAxios.get.mock.calls).toHaveLength(0); // no download
    expect(ctx.coordinator.onImageSettled).not.toHaveBeenCalled();
    // A clear log line and a telemetry event.
    expect(ctx.logs).toContain(
      'Image job image_draft_1_img_1 skipped: image img_1 is already READY (duplicate job)',
    );
    expect(ctx.telemetry.event).toHaveBeenCalledWith(
      'image.duplicate_skipped',
      {
        draftId: 'draft_1',
        imageId: 'img_1',
        jobId: 'image_draft_1_img_1',
      },
    );
  });

  it('reads the row BEFORE markImageProcessing (which would flip READY back)', async () => {
    const ctx = build({ status: 'PROCESSING', processedUrl: null });
    await ctx.proc.process(job());
    expect(ctx.drafts.findImageState.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.drafts.markImageProcessing.mock.invocationCallOrder[0],
    );
  });

  it.each([
    [
      'PROCESSING (first run or recovery)',
      { status: 'PROCESSING', processedUrl: null },
    ],
    // A FAILED row is reset to PROCESSING before its retry is enqueued; a job
    // that still finds it FAILED is not a duplicate either.
    ['FAILED', { status: 'FAILED', processedUrl: null }],
    // READY without a result is inconsistent, not finished: processed again.
    ['READY without a processedUrl', { status: 'READY', processedUrl: null }],
    // A row that is gone: the existing behaviour (markImageProcessing decides).
    ['a missing row', null],
  ])('processes as before when the row is %s', async (_label, state) => {
    const ctx = build(state);
    const result = await ctx.proc.process(job());

    expect(result).toBeUndefined();
    expect(ctx.drafts.markImageProcessing).toHaveBeenCalledWith('img_1');
    expect(ctx.imageEnhance.removeBackground).toHaveBeenCalledTimes(1);
    expect(ctx.drafts.markImageReady).toHaveBeenCalledWith(
      'img_1',
      'https://new',
      'new',
      1, // the run's ownership token
    );
    expect(ctx.coordinator.onImageSettled).toHaveBeenCalledWith('draft_1');
    expect(ctx.telemetry.event).not.toHaveBeenCalledWith(
      'image.duplicate_skipped',
      expect.anything(),
    );
  });

  it('counts a skipped job as a finished queue job, but not as image processing', () => {
    const ctx = build(null);
    ctx.proc.onCompleted({
      ...job(),
      returnvalue: { skipped: 'already_ready' },
    } as never);
    expect(ctx.metrics.observeJob).toHaveBeenCalledWith(
      'image-processing',
      'success',
    );
    expect(ctx.metrics.observeImageProcessing).not.toHaveBeenCalled();

    const done = build(null);
    done.proc.onCompleted({ ...job(), returnvalue: undefined } as never);
    expect(done.metrics.observeImageProcessing).toHaveBeenCalledWith(
      'success',
      2,
    );
  });

  it('is NOT exactly-once: two runs that both read PROCESSING both call FLUX', async () => {
    // What BullMQ's stalled-job recovery can produce when a run loses its lock
    // while still going. The guard cannot see the other run; only the
    // conditional finalization picks one winner (image-processing.finalization.spec.ts).
    const ctx = build({ status: 'PROCESSING', processedUrl: null });
    await Promise.all([ctx.proc.process(job()), ctx.proc.process(job())]);
    expect(ctx.imageEnhance.removeBackground).toHaveBeenCalledTimes(2);
    expect(ctx.drafts.markImageReady).toHaveBeenCalledTimes(2);
  });
});
