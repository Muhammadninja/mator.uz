// Unit tests for the thin ProductDraftService data layer. Prisma is mocked — no
// DB. The focus is the parts with real logic:
//   • tryTransition issues the exact optimistic-locked WHERE (id+status+version),
//     bumps version, and maps count → boolean (won/lost the race).
//   • resetFailedImages flips only FAILED rows back to PROCESSING/QUEUED (originals
//     preserved) and returns the album-ordered set to re-enqueue.
//   • collectPublicIds returns both original and processed public_ids, skipping nulls.
// The trivial pass-through CRUD methods are exercised enough to guard their args.

import {
  DraftImageStatus,
  DraftStatus,
  ImageProcessingStage,
} from '@prisma/client';
import { ProductDraftService } from './product-draft.service';

function makePrismaMock() {
  return {
    productDraft: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    productDraftImage: {
      update: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(),
    },
  };
}

describe('ProductDraftService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: ProductDraftService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new ProductDraftService(prisma as never);
  });

  describe('tryTransition (optimistic lock)', () => {
    it('returns true and issues id+status+version guard with version increment when one row matches', async () => {
      prisma.productDraft.updateMany.mockResolvedValue({ count: 1 });

      const ok = await service.tryTransition(
        'draft_1',
        DraftStatus.CREATING,
        DraftStatus.READY_FOR_PREVIEW,
        3,
      );

      expect(ok).toBe(true);
      expect(prisma.productDraft.updateMany).toHaveBeenCalledWith({
        where: { id: 'draft_1', status: DraftStatus.CREATING, version: 3 },
        data: {
          status: DraftStatus.READY_FOR_PREVIEW,
          version: { increment: 1 },
        },
      });
    });

    it('returns false when no row matches (someone else won the race — stale version/status)', async () => {
      prisma.productDraft.updateMany.mockResolvedValue({ count: 0 });

      const ok = await service.tryTransition(
        'draft_1',
        DraftStatus.CREATING,
        DraftStatus.READY_FOR_PREVIEW,
        3,
      );

      expect(ok).toBe(false);
    });
  });

  describe('resetFailedImages', () => {
    it('resets only FAILED rows to PROCESSING/QUEUED (clearing lastError) and returns processing rows in order', async () => {
      prisma.productDraftImage.updateMany.mockResolvedValue({ count: 2 });
      const rows = [
        { id: 'dimg_1', sortOrder: 0 },
        { id: 'dimg_2', sortOrder: 1 },
      ];
      prisma.productDraftImage.findMany.mockResolvedValue(rows);

      const result = await service.resetFailedImages('draft_1');

      expect(prisma.productDraftImage.updateMany).toHaveBeenCalledWith({
        where: { draftId: 'draft_1', status: DraftImageStatus.FAILED },
        data: {
          status: DraftImageStatus.PROCESSING,
          stage: ImageProcessingStage.QUEUED,
          lastError: null,
        },
      });
      expect(prisma.productDraftImage.findMany).toHaveBeenCalledWith({
        where: { draftId: 'draft_1', status: DraftImageStatus.PROCESSING },
        orderBy: { sortOrder: 'asc' },
      });
      expect(result).toBe(rows);
    });
  });

  describe('collectPublicIds', () => {
    it('returns both original and processed public_ids, skipping nulls', async () => {
      prisma.productDraftImage.findMany.mockResolvedValue([
        { originalPublicId: 'orig_1', processedPublicId: 'proc_1' },
        { originalPublicId: 'orig_2', processedPublicId: null },
        { originalPublicId: null, processedPublicId: null },
      ]);

      const ids = await service.collectPublicIds('draft_1');

      expect(ids).toEqual(['orig_1', 'proc_1', 'orig_2']);
    });
  });

  describe('image-row writes keep the status/stage invariant', () => {
    it('markImageReady sets READY + DONE with the processed asset', async () => {
      prisma.productDraftImage.update.mockResolvedValue({});
      await service.markImageReady('dimg_1', 'https://cdn/p.png', 'proc_1');
      expect(prisma.productDraftImage.update).toHaveBeenCalledWith({
        where: { id: 'dimg_1' },
        data: {
          status: DraftImageStatus.READY,
          stage: ImageProcessingStage.DONE,
          processedUrl: 'https://cdn/p.png',
          processedPublicId: 'proc_1',
        },
      });
    });

    it('markImageFailed sets FAILED + FAILED with the error', async () => {
      prisma.productDraftImage.update.mockResolvedValue({});
      await service.markImageFailed('dimg_1', 'boom');
      expect(prisma.productDraftImage.update).toHaveBeenCalledWith({
        where: { id: 'dimg_1' },
        data: {
          status: DraftImageStatus.FAILED,
          stage: ImageProcessingStage.FAILED,
          lastError: 'boom',
        },
      });
    });

    it('setImageStage moves only the technical stage', async () => {
      prisma.productDraftImage.update.mockResolvedValue({});
      await service.setImageStage('dimg_1', ImageProcessingStage.ENHANCING);
      expect(prisma.productDraftImage.update).toHaveBeenCalledWith({
        where: { id: 'dimg_1' },
        data: { stage: ImageProcessingStage.ENHANCING },
      });
    });
  });

  describe('findResumable', () => {
    it('queries the latest CREATING draft within TTL for the seller', async () => {
      prisma.productDraft.findFirst.mockResolvedValue(null);
      const now = new Date('2026-07-25T12:00:00Z');

      await service.findResumable(42, now);

      expect(prisma.productDraft.findFirst).toHaveBeenCalledWith({
        where: {
          sellerId: 42,
          status: DraftStatus.CREATING,
          expiresAt: { gt: now },
        },
        orderBy: { createdAt: 'desc' },
        include: { images: { orderBy: { sortOrder: 'asc' } } },
      });
    });
  });

  describe('recovery/orphan helpers (Phase 2)', () => {
    it('findAwaitingPreview queries the latest READY_FOR_PREVIEW draft within TTL', async () => {
      prisma.productDraft.findFirst.mockResolvedValue(null);
      const now = new Date('2026-07-25T12:00:00Z');

      await service.findAwaitingPreview(7, now);

      expect(prisma.productDraft.findFirst).toHaveBeenCalledWith({
        where: {
          sellerId: 7,
          status: DraftStatus.READY_FOR_PREVIEW,
          expiresAt: { gt: now },
        },
        orderBy: { createdAt: 'desc' },
        include: { images: { orderBy: { sortOrder: 'asc' } } },
      });
    });

    it('findExpired sweeps BOTH CREATING and READY_FOR_PREVIEW past TTL', async () => {
      prisma.productDraft.findMany.mockResolvedValue([]);
      const now = new Date('2026-07-25T12:00:00Z');

      await service.findExpired(now);

      const arg = prisma.productDraft.findMany.mock.calls[0][0];
      expect(arg.where.status).toEqual({
        in: [DraftStatus.CREATING, DraftStatus.READY_FOR_PREVIEW],
      });
      expect(arg.where.expiresAt).toEqual({ lte: now });
    });

    it('publishDraft transitions only a READY_FOR_PREVIEW draft (idempotent) and reports whether it moved', async () => {
      prisma.productDraft.updateMany.mockResolvedValueOnce({ count: 1 });
      expect(await service.publishDraft('draft_1')).toBe(true);
      expect(prisma.productDraft.updateMany).toHaveBeenCalledWith({
        where: { id: 'draft_1', status: DraftStatus.READY_FOR_PREVIEW },
        data: { status: DraftStatus.PUBLISHED },
      });

      prisma.productDraft.updateMany.mockResolvedValueOnce({ count: 0 });
      expect(await service.publishDraft('draft_1')).toBe(false); // already published/gone
    });

    it('collectOriginalPublicIds returns only the stored-original ids (processed kept on publish)', async () => {
      prisma.productDraftImage.findMany.mockResolvedValue([
        { originalPublicId: 'orig_0' },
        { originalPublicId: 'orig_1' },
      ]);

      const ids = await service.collectOriginalPublicIds('draft_1');

      expect(prisma.productDraftImage.findMany).toHaveBeenCalledWith({
        where: { draftId: 'draft_1', originalPublicId: { not: null } },
        select: { originalPublicId: true },
      });
      expect(ids).toEqual(['orig_0', 'orig_1']);
    });
  });
});
