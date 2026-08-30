import { Injectable } from '@nestjs/common';
import {
  DraftImageStatus,
  DraftStatus,
  ImageProcessingStage,
  OilType,
  PackageForm,
  PartMainCategory,
  PartVehicleCategory,
  PartNumberType,
  Prisma,
  ProductKind,
  type ProductDraft,
  type ProductDraftImage,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { IdPrefix, prefixedId } from '../common/ulid.util';
import { capabilitiesOf, type KindRequiredField } from '../common/product-kind';

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
  /** Which questionnaire the draft is running (see ProductKind). */
  kind?: ProductKind;
  brand?: string | null;
  model?: string | null;
  category?: PartVehicleCategory | null;
  subcategory?: PartMainCategory | null;
  /** Dynamic category tree ids — authoritative (the two enums above mirror them
   *  only when the chosen node happens to correspond to a legacy enum value). */
  vehicleCategoryId?: string | null;
  categoryId?: string | null;
  /** The sale form answered at the PACKAGE_FORM step; null when the chosen
   *  category offers a single package code (the question is never asked). */
  packageForm?: PackageForm | null;
  title?: string | null;
  description?: string | null;
  partNumberType?: PartNumberType;
  partNumber?: string | null;
  // MOTOR_OIL attributes — null in every other flow.
  oilViscosity?: string | null;
  oilType?: OilType | null;
  oilVolumeMl?: number | null;
  // ANTIFREEZE attribute — the packaged net weight in GRAMS; null elsewhere.
  antifreezeWeightG?: number | null;
  priceUzs?: Prisma.Decimal | number | null;
}

/**
 * Compile-time guarantee that the patch can carry EVERY field some kind requires.
 *
 * The companion to `_RequiredFieldsAreReadable` below: that one proves the
 * completeness CHECK can read each required field, this one proves the WRITE path
 * can persist it. Without this, a kind could require a column the wizard is
 * structurally unable to save — which is exactly the antifreeze bug: the session
 * held `antifreezeWeightG`, `updateForm` supported it, but the questionnaire's
 * snapshot never passed it, so the column stayed NULL and the rendezvous never
 * fired. Types alone could not catch that (every field here is optional), so the
 * call site is pinned by {@link QuestionnaireSnapshot} instead.
 */
type _RequiredFieldsArePatchable =
  KindRequiredField extends keyof DraftFormPatch ? true : never;
const _requiredFieldsArePatchable: _RequiredFieldsArePatchable = true;
void _requiredFieldsArePatchable;

/**
 * The snapshot `handleFormAdvance` persists when a questionnaire step is answered.
 *
 * REQUIRES (not merely permits) every field any kind lists in its capability
 * table, so omitting one — the antifreeze bug — is a compile error rather than a
 * seller stuck forever on "⏳ Завершаем обработку фото…". A kind that does not use
 * a given field passes `null`, which is explicit and costs nothing; `undefined` is
 * not accepted, because that is precisely the value Prisma silently ignores.
 */
export type QuestionnaireSnapshot = DraftFormPatch & {
  [K in KindRequiredField]: DraftFormPatch[K] extends infer V
    ? Exclude<V, undefined>
    : never;
};

/** One uploaded photo as accepted on the hot path (before any processing). */
export interface DraftImageInput {
  sortOrder: number;
  tgFileId: string;
}

/**
 * The draft fields {@link isDraftFormComplete} reads (a structural subset, so
 * both a full Prisma row and a hand-built object satisfy it).
 *
 * Every {@link KindRequiredField} must appear here — the assertion below makes
 * that a COMPILE-TIME guarantee, so a capability entry cannot name a field the
 * completeness check has no way to read.
 */
export interface DraftFormFields {
  kind: ProductKind;
  title: string | null;
  priceUzs: Prisma.Decimal | null;
  brand: string | null;
  model: string | null;
  category: PartVehicleCategory | null;
  /**
   * The chosen category-tree node. This — not `category` — is what SPARE_PART
   * requires, because an admin-created category has no legacy enum mirror and
   * would otherwise leave `category` null on a fully-answered draft.
   *
   * Requiring the ID is also what makes the "skip the step when the category has
   * no children" rule safe: `selectCategory` sets categoryId to the ROOT when
   * that root is a leaf, so a draft that never saw a subcategory question is
   * still complete. Nothing here demands a SUBcategory — the wizard flow asks
   * that question only where it exists.
   */
  categoryId: string | null;
  oilViscosity: string | null;
  oilType: OilType | null;
  oilVolumeMl: number | null;
  antifreezeWeightG: number | null;
}

// Compile-time guarantee that every field a capability entry can REQUIRE is a
// field this interface actually exposes. If a new kind declares a required field
// that DraftFormFields cannot read, this line fails to compile — rather than the
// completeness check silently reading `undefined` and passing.
type _RequiredFieldsAreReadable =
  KindRequiredField extends keyof DraftFormFields ? true : never;
const _requiredFieldsAreReadable: _RequiredFieldsAreReadable = true;
void _requiredFieldsAreReadable;

/**
 * Whether a draft carries every field ITS KIND requires — i.e. the questionnaire
 * that ran actually filled in what it asks for.
 *
 * THE SINGLE DEFINITION OF "form complete", and it holds NO per-kind knowledge of
 * its own: the required fields come from the kind capability table
 * (common/product-kind.ts), so adding a kind changes that table and nothing here.
 *
 * Both gates call this one function and therefore cannot disagree:
 * DraftCoordinator uses it for the rendezvous (CREATING → READY_FOR_PREVIEW), and
 * TelegramService uses it to decide a draft may be previewed/committed. A second,
 * hand-maintained copy is exactly the bug this replaces — the coordinator's own
 * version demanded brand/model/category, which a motor oil never has, so a fully
 * answered oil whose images had all gone READY silently failed the rendezvous and
 * left the seller on "⏳ Завершаем обработку фото…" forever.
 *
 * Title and price are required by every kind, so they are checked here rather
 * than repeated in every capability entry.
 */
export function isDraftFormComplete(draft: DraftFormFields): boolean {
  if (draft.title === null || draft.priceUzs === null) return false;
  return capabilitiesOf(draft.kind).requiredFields.every(
    (field) => draft[field] !== null,
  );
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

  /**
   * "🖼 Изменить фото" — clone a draft's FORM fields into a brand-new CREATING draft
   * with NO images, and mark the source CANCELLED, in one transaction.
   *
   * Replacing photos is modelled as "a new draft based on the existing one" rather
   * than as mutating the current draft: the source already carries READY images,
   * their Cloudinary assets, and possibly in-flight jobs, so clearing and reusing it
   * would race the worker and the coordinator. Cloning sidesteps that entirely — the
   * old draft becomes terminal (nothing can advance it, the sweep ignores it) while
   * the new one starts clean at PHOTOS_FIRST with every answered field carried over,
   * so the seller retypes nothing.
   *
   * The source's asset ids are collected by the CALLER (collectPublicIds) before this
   * runs, since deletion is external I/O this data layer does not perform.
   * Returns the new draft, or null if the source was no longer in `expectedStatus`
   * (already published/cancelled/expired — a stale tap).
   */
  async cloneForPhotoReplacement(params: {
    sourceId: string;
    expectedStatus: DraftStatus;
    expiresAt: Date;
    formStep: string;
  }): Promise<ProductDraft | null> {
    const source = await this.prisma.productDraft.findUnique({
      where: { id: params.sourceId },
    });
    if (!source || source.status !== params.expectedStatus) return null;

    const newId = prefixedId(IdPrefix.DRAFT);
    // One transaction: if the create fails, the source's CANCELLED rolls back too,
    // so the seller keeps their preview and can simply tap again.
    return this.prisma.$transaction(async (tx) => {
      // Terminate the source under its OBSERVED status+version, so a concurrent
      // transition (publish, sweep, another tap) makes this whole clone a no-op.
      const { count } = await tx.productDraft.updateMany({
        where: {
          id: params.sourceId,
          status: params.expectedStatus,
          version: source.version,
        },
        data: { status: DraftStatus.CANCELLED, version: { increment: 1 } },
      });
      if (count !== 1) return null;

      return tx.productDraft.create({
        data: {
          id: newId,
          sellerId: source.sellerId,
          tgId: source.tgId,
          status: DraftStatus.CREATING,
          formStep: params.formStep,
          expiresAt: params.expiresAt,
          // Every answered field carries over; images deliberately do NOT. That
          // includes `kind`, so replacing an oil's photos resumes the OIL
          // questionnaire rather than dropping back to the spare-parts one.
          kind: source.kind,
          brand: source.brand,
          model: source.model,
          category: source.category,
          subcategory: source.subcategory,
          vehicleCategoryId: source.vehicleCategoryId,
          categoryId: source.categoryId,
          // The sale form travels with the category it was answered for, so
          // replacing photos does not re-ask a question already settled.
          packageForm: source.packageForm,
          title: source.title,
          description: source.description,
          partNumberType: source.partNumberType,
          partNumber: source.partNumber,
          oilViscosity: source.oilViscosity,
          oilType: source.oilType,
          oilVolumeMl: source.oilVolumeMl,
          antifreezeWeightG: source.antifreezeWeightG,
          priceUzs: source.priceUzs,
        },
      });
    });
  }

  /**
   * "⬅️ Назад" — move a READY_FOR_PREVIEW draft back to CREATING so the seller can
   * edit text/price, under the optimistic lock. The images (and their processed
   * assets) are untouched and stay READY, so returning to the preview reuses them
   * and re-runs NO image processing — the rendezvous simply fires again once the
   * form is re-submitted.
   *
   * `previewSentAt` is CLEARED so the next rendezvous may send a fresh preview: the
   * send-once claim is per preview delivery, and this edit deliberately starts a new
   * one. Returns false when the draft moved on (already published/cancelled/expired,
   * or a double-tap won the race).
   */
  async reopenForEdit(
    draftId: string,
    expectedVersion: number,
    formStep: string,
  ): Promise<boolean> {
    const { count } = await this.prisma.productDraft.updateMany({
      where: {
        id: draftId,
        status: DraftStatus.READY_FOR_PREVIEW,
        version: expectedVersion,
      },
      data: {
        status: DraftStatus.CREATING,
        formStep,
        previewSentAt: null,
        version: { increment: 1 },
      },
    });
    return count === 1;
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

  /**
   * The seller's in-flight draft: a live (CREATING, within TTL) draft that still
   * has at least one image row PROCESSING — i.e. the image pipeline is genuinely
   * mid-flight for them right now.
   *
   * This is the state source that gates STARTING A NEW LISTING. It is deliberately
   * derived from the same rows the rendezvous itself reads (draft status + image
   * status) rather than from a separate in-memory flag: a flag would be a second,
   * process-local copy of a fact the DB already owns, and would be wrong after a
   * restart, across replicas, or whenever a worker settles a row without the bot
   * thread noticing. Because both gates read one source, "the bot says photos are
   * processing" and "the coordinator is still waiting for images" cannot disagree.
   *
   * Returns null the moment the last row settles (READY or FAILED), so the block
   * lifts exactly when the batch finishes — including the failure case, where the
   * seller must be able to reach the retry/cancel buttons.
   */
  findImagesInFlight(
    sellerId: number,
    now: Date = new Date(),
  ): Promise<DraftWithImages | null> {
    return this.prisma.productDraft.findFirst({
      where: {
        sellerId,
        status: DraftStatus.CREATING,
        expiresAt: { gt: now },
        images: { some: { status: DraftImageStatus.PROCESSING } },
      },
      orderBy: { createdAt: 'desc' },
      include: { images: { orderBy: { sortOrder: 'asc' } } },
    });
  }

  /**
   * The most recent draft for a seller that is READY_FOR_PREVIEW and within TTL —
   * used on /start to RE-PRESENT a preview whose delivery was lost (e.g. the backend
   * crashed after the coordinator flipped the draft but before the preview message
   * was sent). Without this such a draft is invisible (findResumable only matches
   * CREATING) and its assets would orphan until the sweep.
   */
  findAwaitingPreview(
    sellerId: number,
    now: Date = new Date(),
  ): Promise<DraftWithImages | null> {
    return this.prisma.productDraft.findFirst({
      where: {
        sellerId,
        status: DraftStatus.READY_FOR_PREVIEW,
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
        kind: patch.kind,
        brand: patch.brand,
        model: patch.model,
        category: patch.category,
        subcategory: patch.subcategory,
        vehicleCategoryId: patch.vehicleCategoryId,
        categoryId: patch.categoryId,
        packageForm: patch.packageForm,
        title: patch.title,
        description: patch.description,
        partNumberType: patch.partNumberType,
        partNumber: patch.partNumber,
        oilViscosity: patch.oilViscosity,
        oilType: patch.oilType,
        oilVolumeMl: patch.oilVolumeMl,
        antifreezeWeightG: patch.antifreezeWeightG,
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
   *
   * A processed asset is EXCLUDED once a live ProductImage points at its URL: on the
   * publish path those assets stop belonging to the draft and become the product's.
   * This matters for a draft swept in COMMITTING, where the commit may have written
   * the product rows and died before `publishDraft` — the draft looks abandoned but
   * its processed assets are already a live product's images. Deleting them would
   * leave the product intact with every image 404ing. Stored originals are never
   * referenced by a product and are always reclaimed.
   *
   * The invariant this relies on is NOT "a URL is immutable" — it is the weaker and
   * actually-true "a ProductImage row's `url` is never rewritten in place". Verified:
   * the only writes to product_images anywhere are the deleteMany + createMany pair
   * in the confirm path (telegram.service.ts), which replaces whole rows; no code
   * path issues an UPDATE on that column, and no raw SQL touches the table.
   *
   * Consequence — a URL can stop being claimed (seller B lists the same gmNumber, and
   * the confirm path's gallery replacement deletes seller A's rows), but a URL a
   * draft owns can never START being claimed by a product this draft did not write.
   * So the query can only err toward SPARING an asset, never toward deleting a live
   * one: a stale "claimed" answer leaks an asset (harmless — cleanup is best-effort
   * and re-deleting is a no-op), while the dangerous direction is unreachable.
   */
  async collectPublicIds(draftId: string): Promise<string[]> {
    const rows = await this.prisma.productDraftImage.findMany({
      where: { draftId },
      select: {
        originalPublicId: true,
        processedPublicId: true,
        processedUrl: true,
      },
    });

    const ids: string[] = [];
    for (const r of rows) {
      if (r.originalPublicId) ids.push(r.originalPublicId);
    }

    const processed = rows.filter((r) => r.processedPublicId);
    if (processed.length === 0) return ids;

    // One query for the whole draft: which processed URLs a product already claims.
    const claimedUrls = await this.prisma.productImage.findMany({
      where: {
        url: {
          in: processed
            .map((r) => r.processedUrl)
            .filter((u): u is string => !!u),
        },
      },
      select: { url: true },
    });
    const claimed = new Set(claimedUrls.map((row) => row.url));

    for (const r of processed) {
      // A row whose processedUrl is null cannot be a product's image — reclaim it.
      if (r.processedUrl && claimed.has(r.processedUrl)) continue;
      ids.push(r.processedPublicId as string);
    }
    return ids;
  }

  /**
   * The STORED-ORIGINAL public_ids only. On publish the PROCESSED assets become the
   * product's images (kept), but the originals were just an intermediate for the
   * worker — they should be deleted so they don't orphan.
   */
  async collectOriginalPublicIds(draftId: string): Promise<string[]> {
    const rows = await this.prisma.productDraftImage.findMany({
      where: { draftId, originalPublicId: { not: null } },
      select: { originalPublicId: true },
    });
    return rows.map((r) => r.originalPublicId as string);
  }

  /**
   * Mark a draft PUBLISHED (idempotent): a repeat or a double-tap is a safe no-op.
   * Terminal, so no version guard is needed — once PUBLISHED the `status` predicate
   * excludes every competitor, including the TTL sweep. Returns whether this call
   * performed the transition.
   *
   * Two source states are accepted:
   *   • COMMITTING       — the normal path. The confirm flow claims the draft before
   *     writing the product and closes the claim here once the write succeeded.
   *   • READY_FOR_PREVIEW — the parallel/legacy path, where a caller publishes a
   *     draft it never claimed (and any in-flight draft still in that state when this
   *     ships).
   */
  async publishDraft(draftId: string): Promise<boolean> {
    const { count } = await this.prisma.productDraft.updateMany({
      where: {
        id: draftId,
        status: {
          in: [DraftStatus.COMMITTING, DraftStatus.READY_FOR_PREVIEW],
        },
      },
      data: { status: DraftStatus.PUBLISHED },
    });
    return count === 1;
  }

  /**
   * Atomically claim the right to SEND the preview for a draft — a compare-and-set:
   *   UPDATE ... SET previewSentAt = now, version = version + 1
   *   WHERE id = ? AND status = READY_FOR_PREVIEW AND previewSentAt IS NULL
   * Returns true iff exactly one row matched (this caller won). Two racing
   * candidates — the worker's ready-for-preview event and a /start recovery — can
   * both read READY_FOR_PREVIEW, but only one gets count === 1 and sends; the loser
   * (count === 0) bails, so `storePending` never runs twice (which would delete the
   * winner's Cloudinary assets). `status` is left READY_FOR_PREVIEW (still awaiting
   * confirm); no reset is needed on publish/cancel since those are terminal.
   */
  async claimPreviewSend(
    draftId: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const { count } = await this.prisma.productDraft.updateMany({
      where: {
        id: draftId,
        status: DraftStatus.READY_FOR_PREVIEW,
        previewSentAt: null,
      },
      data: { previewSentAt: now, version: { increment: 1 } },
    });
    return count === 1;
  }

  /**
   * Drafts whose TTL has elapsed and may still own assets — the sweep's input:
   *   • CREATING           — abandoned mid-flow;
   *   • READY_FOR_PREVIEW  — a preview produced but never confirmed/cancelled (the
   *     seller walked away, or its delivery was lost);
   *   • CANCELLED          — cancelled but possibly not yet cleaned: every cancel
   *     path deletes assets right after the transition, so a crash in that gap
   *     would otherwise orphan them forever. Sweeping CANCELLED closes that window;
   *     re-deleting already-removed assets is a harmless no-op.
   *   • COMMITTING         — a commit claimed the draft but never finished (the
   *     process died between the claim and the product write). This is exactly why
   *     the claim uses COMMITTING rather than PUBLISHED: the draft stays sweepable,
   *     so its assets are reclaimed instead of leaking. `expiresAt` gates it, so a
   *     commit genuinely in flight is never swept out from under itself.
   * PUBLISHED is deliberately excluded — its processed assets belong to a live
   * product and must never be touched.
   */
  findExpired(now: Date = new Date(), take = 100): Promise<DraftWithImages[]> {
    return this.prisma.productDraft.findMany({
      where: {
        status: {
          in: [
            DraftStatus.CREATING,
            DraftStatus.READY_FOR_PREVIEW,
            DraftStatus.COMMITTING,
            DraftStatus.CANCELLED,
          ],
        },
        expiresAt: { lte: now },
      },
      orderBy: { expiresAt: 'asc' },
      take,
      include: { images: { orderBy: { sortOrder: 'asc' } } },
    });
  }
}
