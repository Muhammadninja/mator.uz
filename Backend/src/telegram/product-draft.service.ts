import { Injectable } from '@nestjs/common';
import {
  DraftImageStatus,
  DraftStatus,
  ImageProcessingStage,
  PartVehicleCategory,
  PartNumberType,
  Prisma,
  type ProductDraft,
  type ProductDraftImage,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { IdPrefix, prefixedId } from '../common/ulid.util';

/**
 * ProductDraftService — the THIN data layer for the product-creation draft
 * lifecycle. It does persistence only: create/read/update the draft and its image
 * rows, and expose the single VERSIONED status-transition primitive
 * (`tryTransition`). It holds NO orchestration/rendezvous rules and emits NO
 * events — that is DraftCoordinator's job. Keeping this class dumb is deliberate
 * (the plan's "no god-object" decision): everything here is trivially unit-testable
 * against Prisma alone.
 *
 * Two state axes live on the rows (see schema): `Draft.status` (form/user axis,
 * optimistically locked via `version`) and, per image, `status` (user axis, gates
 * the rendezvous) + `stage` (technical axis, observability only). This service
 * writes them; it never interprets them.
 */

/** A draft with its image rows loaded (what the coordinator reads). */
export type DraftWithImages = ProductDraft & { images: ProductDraftImage[] };

/** Fields the wizard fills in as the questionnaire progresses. All optional so a
 *  single call can patch just the step that changed, plus the advanced formStep. */
export interface DraftFormPatch {
  formStep?: string;
  brand?: string | null;
  model?: string | null;
  category?: PartVehicleCategory | null;
  title?: string | null;
  description?: string | null;
  partNumberType?: PartNumberType;
  partNumber?: string | null;
  priceUzs?: Prisma.Decimal | number | null;
}

/** One uploaded photo as accepted on the hot path (before any processing). */
export interface DraftImageInput {
  sortOrder: number;
  tgFileId: string;
}

@Injectable()
export class ProductDraftService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Creation ──────────────────────────────────────────────────────────────
  /**
   * Create a draft (status=CREATING, version=0) together with one PROCESSING image
   * row per uploaded photo, in a single transaction. `expiresAt` is the DB-visible
   * TTL used by the cleanup sweep and the /start resume window. Returns the draft
   * with its image rows so the caller can enqueue a job per row by id.
   */
  async createWithImages(params: {
    sellerId: number;
    tgId: bigint;
    formStep: string;
    expiresAt: Date;
    images: DraftImageInput[];
  }): Promise<DraftWithImages> {
    const draftId = prefixedId(IdPrefix.DRAFT);
    return this.prisma.productDraft.create({
      data: {
        id: draftId,
        sellerId: params.sellerId,
        tgId: params.tgId,
        status: DraftStatus.CREATING,
        formStep: params.formStep,
        expiresAt: params.expiresAt,
        images: {
          create: params.images.map((img) => ({
            id: prefixedId(IdPrefix.DRAFT_IMAGE),
            sortOrder: img.sortOrder,
            tgFileId: img.tgFileId,
            status: DraftImageStatus.PROCESSING,
            stage: ImageProcessingStage.QUEUED,
          })),
        },
      },
      include: { images: { orderBy: { sortOrder: 'asc' } } },
    });
  }

  // ── Reads ─────────────────────────────────────────────────────────────────
  /** Load a draft with its image rows (album order). null if it doesn't exist. */
  findWithImages(draftId: string): Promise<DraftWithImages | null> {
    return this.prisma.productDraft.findUnique({
      where: { id: draftId },
      include: { images: { orderBy: { sortOrder: 'asc' } } },
    });
  }

  /**
   * The most recent still-in-progress (CREATING) draft for a seller whose TTL has
   * not elapsed — the candidate offered for "resume" on /start. Older drafts are
   * left for the cleanup sweep and never resurfaced.
   */
  findResumable(
    sellerId: number,
    now: Date = new Date(),
  ): Promise<DraftWithImages | null> {
    return this.prisma.productDraft.findFirst({
      where: {
        sellerId,
        status: DraftStatus.CREATING,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
      include: { images: { orderBy: { sortOrder: 'asc' } } },
    });
  }

  // ── Form-field writes ───────────────────────────────────────────────────────
  /** Patch the wizard fields that changed on a step (and usually `formStep`). Does
   *  NOT touch `status`/`version` — form progress is not a status transition. */
  async updateForm(draftId: string, patch: DraftFormPatch): Promise<void> {
    await this.prisma.productDraft.update({
      where: { id: draftId },
      data: {
        formStep: patch.formStep,
        brand: patch.brand,
        model: patch.model,
        category: patch.category,
        title: patch.title,
        description: patch.description,
        partNumberType: patch.partNumberType,
        partNumber: patch.partNumber,
        priceUzs: patch.priceUzs ?? undefined,
      },
    });
  }

  // ── Versioned status transition (the optimistic lock) ───────────────────────
  /**
   * Attempt a draft status transition under optimistic locking:
   *   UPDATE ... SET status=to, version=version+1
   *   WHERE id=? AND status=from AND version=expectedVersion
   * Returns true iff exactly one row matched (this caller won the race). A false
   * result means someone else already moved the draft (another worker, the form
   * thread, or the TTL sweep) — the caller should re-read and re-decide.
   *
   * This is the ONLY way `status` changes, so every transition is serialized and
   * the `CREATING → READY_FOR_PREVIEW` flip is exactly-once. `status=from` is kept
   * alongside the version check as a semantic guard.
   */
  async tryTransition(
    draftId: string,
    from: DraftStatus,
    to: DraftStatus,
    expectedVersion: number,
  ): Promise<boolean> {
    const { count } = await this.prisma.productDraft.updateMany({
      where: { id: draftId, status: from, version: expectedVersion },
      data: { status: to, version: { increment: 1 } },
    });
    return count === 1;
  }

  // ── Image-row writes (single-writer: the row's own worker job) ──────────────
  /** Mark the row PROCESSING and bump its attempt counter (worker pickup). */
  async markImageProcessing(imageId: string): Promise<ProductDraftImage> {
    return this.prisma.productDraftImage.update({
      where: { id: imageId },
      data: {
        status: DraftImageStatus.PROCESSING,
        attempts: { increment: 1 },
      },
    });
  }

  /** Advance only the technical `stage` (observability). Never changes `status`. */
  async setImageStage(
    imageId: string,
    stage: ImageProcessingStage,
  ): Promise<void> {
    await this.prisma.productDraftImage.update({
      where: { id: imageId },
      data: { stage },
    });
  }

  /** Record the stored ORIGINAL after phase A (ingest). Leaves status PROCESSING. */
  async setImageOriginal(
    imageId: string,
    originalUrl: string,
    originalPublicId: string,
  ): Promise<ProductDraftImage> {
    return this.prisma.productDraftImage.update({
      where: { id: imageId },
      data: { originalUrl, originalPublicId },
    });
  }

  /** Phase B success: READY + stage=DONE, with the processed asset. (DONE⇔READY.) */
  async markImageReady(
    imageId: string,
    processedUrl: string,
    processedPublicId: string,
  ): Promise<void> {
    await this.prisma.productDraftImage.update({
      where: { id: imageId },
      data: {
        status: DraftImageStatus.READY,
        stage: ImageProcessingStage.DONE,
        processedUrl,
        processedPublicId,
      },
    });
  }

  /** Terminal failure: FAILED + stage=FAILED, keeping the last error. (FAILED⇔FAILED.) */
  async markImageFailed(imageId: string, lastError: string): Promise<void> {
    await this.prisma.productDraftImage.update({
      where: { id: imageId },
      data: {
        status: DraftImageStatus.FAILED,
        stage: ImageProcessingStage.FAILED,
        lastError,
      },
    });
  }

  /** Store the BullMQ job id on a row (set right after enqueue). */
  async setImageJobId(imageId: string, jobId: string): Promise<void> {
    await this.prisma.productDraftImage.update({
      where: { id: imageId },
      data: { jobId },
    });
  }

  /**
   * Reset the FAILED rows of a draft back to PROCESSING/QUEUED so they can be
   * re-enqueued on retry. Preserves any already-stored `originalUrl` so a retry
   * resumes at phase B (enhance) without re-touching Telegram. Returns the reset
   * rows (album order) for the caller to re-enqueue.
   */
  async resetFailedImages(draftId: string): Promise<ProductDraftImage[]> {
    await this.prisma.productDraftImage.updateMany({
      where: { draftId, status: DraftImageStatus.FAILED },
      data: {
        status: DraftImageStatus.PROCESSING,
        stage: ImageProcessingStage.QUEUED,
        lastError: null,
      },
    });
    return this.prisma.productDraftImage.findMany({
      where: { draftId, status: DraftImageStatus.PROCESSING },
      orderBy: { sortOrder: 'asc' },
    });
  }

  // ── Cleanup helpers ─────────────────────────────────────────────────────────
  /**
   * All Cloudinary public_ids owned by a draft (both stored originals and
   * processed results), for asset deletion on cancel/expiry/replace. The caller
   * (which owns the CloudinaryService) performs the actual deletion — this data
   * layer does no external I/O.
   */
  async collectPublicIds(draftId: string): Promise<string[]> {
    const rows = await this.prisma.productDraftImage.findMany({
      where: { draftId },
      select: { originalPublicId: true, processedPublicId: true },
    });
    const ids: string[] = [];
    for (const r of rows) {
      if (r.originalPublicId) ids.push(r.originalPublicId);
      if (r.processedPublicId) ids.push(r.processedPublicId);
    }
    return ids;
  }

  /** Drafts whose TTL has elapsed and are still in progress — the sweep's input. */
  findExpired(now: Date = new Date(), take = 100): Promise<DraftWithImages[]> {
    return this.prisma.productDraft.findMany({
      where: { status: DraftStatus.CREATING, expiresAt: { lte: now } },
      orderBy: { expiresAt: 'asc' },
      take,
      include: { images: { orderBy: { sortOrder: 'asc' } } },
    });
  }
}
