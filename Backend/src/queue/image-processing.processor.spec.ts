// Unit tests for the two-phase ImageProcessingProcessor. All collaborators are
// mocked (no Telegram, no Cloudinary, no FLUX, no DB). The behaviours that matter:
//   • first pickup runs BOTH phases: ingest (Telegram download → store original) then
//     enhance (FLUX → store processed), marks READY, and settles the draft.
//   • a retry where originalUrl is already set SKIPS phase A (no Telegram call) and
//     only re-runs enhance — the short-lived file_id is never re-fetched.
//   • stage advances INGESTING_ORIGINAL → ENHANCING → UPLOADING_RESULT (observability).
//   • onFailed marks FAILED + settles ONLY on the final attempt (not mid-retry).

import { ImageProcessingStage } from '@prisma/client';
import axios from 'axios';
import { ImageProcessingProcessor } from './queue.processors';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

function build() {
  const drafts = {
    markImageProcessing: jest.fn(),
    setImageStage: jest.fn().mockResolvedValue(undefined),
    setImageOriginal: jest.fn().mockResolvedValue(undefined),
    markImageReady: jest.fn().mockResolvedValue(undefined),
    markImageFailed: jest.fn().mockResolvedValue(undefined),
  };
  const coordinator = {
    onImageSettled: jest.fn().mockResolvedValue(undefined),
  };
  const cloudinary = { uploadBuffer: jest.fn() };
  const telegramFiles = { getFileUrl: jest.fn() };
  const imageEnhance = { removeBackground: jest.fn() };
  const telemetry = { event: jest.fn(), metric: jest.fn() };
  const proc = new ImageProcessingProcessor(
    drafts as never,
    coordinator as never,
    cloudinary as never,
    telegramFiles as never,
    imageEnhance as never,
    telemetry as never,
  );
  jest
    .spyOn((proc as never as { logger: { error: unknown } }).logger, 'error')
    .mockImplementation(() => undefined);
  jest
    .spyOn((proc as never as { logger: { log: unknown } }).logger, 'log')
    .mockImplementation(() => undefined);
  return {
    proc,
    drafts,
    coordinator,
    cloudinary,
    telegramFiles,
    imageEnhance,
    telemetry,
  };
}

describe('ImageProcessingProcessor (two-phase)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('first pickup: ingest original, then enhance, mark READY, settle', async () => {
    const ctx = build();
    // Row has no originalUrl yet → phase A runs.
    ctx.drafts.markImageProcessing.mockResolvedValue({
      id: 'dimg_1',
      tgFileId: 'tgfile',
      originalUrl: null,
    });
    ctx.telegramFiles.getFileUrl.mockResolvedValue('https://tg/file');
    mockedAxios.get.mockResolvedValue({ data: new ArrayBuffer(8) });
    ctx.cloudinary.uploadBuffer
      .mockResolvedValueOnce({
        url: 'https://cdn/original.jpg',
        publicId: 'orig_1',
      }) // ingest
      .mockResolvedValueOnce({
        url: 'https://cdn/processed.png',
        publicId: 'proc_1',
      }); // enhance
    ctx.imageEnhance.removeBackground.mockResolvedValue(Buffer.from('png'));

    await ctx.proc.process({
      id: 'j1',
      data: { draftId: 'draft_1', imageId: 'dimg_1' },
      opts: { attempts: 3 },
    } as never);

    // Phase A: Telegram download + original stored.
    expect(ctx.telegramFiles.getFileUrl).toHaveBeenCalledWith('tgfile');
    expect(ctx.drafts.setImageOriginal).toHaveBeenCalledWith(
      'dimg_1',
      'https://cdn/original.jpg',
      'orig_1',
    );
    // Phase B: FLUX + processed stored + READY + settle.
    expect(ctx.imageEnhance.removeBackground).toHaveBeenCalled();
    expect(ctx.drafts.markImageReady).toHaveBeenCalledWith(
      'dimg_1',
      'https://cdn/processed.png',
      'proc_1',
    );
    expect(ctx.coordinator.onImageSettled).toHaveBeenCalledWith('draft_1');
    // Stage progression.
    const stages = ctx.drafts.setImageStage.mock.calls.map((c) => c[1]);
    expect(stages).toEqual([
      ImageProcessingStage.INGESTING_ORIGINAL,
      ImageProcessingStage.ENHANCING,
      ImageProcessingStage.UPLOADING_RESULT,
    ]);
  });

  it('retry with original already stored SKIPS phase A (no Telegram fetch)', async () => {
    const ctx = build();
    ctx.drafts.markImageProcessing.mockResolvedValue({
      id: 'dimg_1',
      tgFileId: 'tgfile',
      originalUrl: 'https://cdn/original.jpg', // already ingested
    });
    mockedAxios.get.mockResolvedValue({ data: new ArrayBuffer(8) });
    ctx.cloudinary.uploadBuffer.mockResolvedValue({
      url: 'https://cdn/processed.png',
      publicId: 'proc_1',
    });
    ctx.imageEnhance.removeBackground.mockResolvedValue(Buffer.from('png'));

    await ctx.proc.process({
      id: 'j1',
      data: { draftId: 'draft_1', imageId: 'dimg_1' },
      opts: { attempts: 3 },
    } as never);

    expect(ctx.telegramFiles.getFileUrl).not.toHaveBeenCalled(); // phase A skipped
    expect(ctx.drafts.setImageOriginal).not.toHaveBeenCalled();
    expect(ctx.cloudinary.uploadBuffer).toHaveBeenCalledTimes(1); // only the processed upload
    expect(ctx.drafts.markImageReady).toHaveBeenCalled();
    expect(ctx.coordinator.onImageSettled).toHaveBeenCalledWith('draft_1');
    // Stage starts at ENHANCING (no ingest stage).
    const stages = ctx.drafts.setImageStage.mock.calls.map((c) => c[1]);
    expect(stages).toEqual([
      ImageProcessingStage.ENHANCING,
      ImageProcessingStage.UPLOADING_RESULT,
    ]);
  });

  it('onFailed does NOT mark failed mid-retry (attempt < max)', async () => {
    const ctx = build();
    await ctx.proc.onFailed(
      {
        data: { draftId: 'draft_1', imageId: 'dimg_1' },
        attemptsMade: 1,
        opts: { attempts: 3 },
      } as never,
      new Error('transient'),
    );
    expect(ctx.drafts.markImageFailed).not.toHaveBeenCalled();
    expect(ctx.coordinator.onImageSettled).not.toHaveBeenCalled();
  });

  it('onFailed marks FAILED and settles on the final attempt', async () => {
    const ctx = build();
    await ctx.proc.onFailed(
      {
        data: { draftId: 'draft_1', imageId: 'dimg_1' },
        attemptsMade: 3,
        opts: { attempts: 3 },
      } as never,
      new Error('boom'),
    );
    expect(ctx.drafts.markImageFailed).toHaveBeenCalledWith('dimg_1', 'boom');
    expect(ctx.coordinator.onImageSettled).toHaveBeenCalledWith('draft_1');
  });

  it('onFailed tolerates an undefined job', async () => {
    const ctx = build();
    await expect(
      ctx.proc.onFailed(undefined, new Error('x')),
    ).resolves.toBeUndefined();
    expect(ctx.drafts.markImageFailed).not.toHaveBeenCalled();
  });
});
