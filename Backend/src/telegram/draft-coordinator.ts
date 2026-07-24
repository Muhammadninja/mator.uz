import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DraftImageStatus, DraftStatus } from '@prisma/client';
import {
  DraftEvent,
  type DraftImagesFailedEvent,
  type DraftReadyForPreviewEvent,
} from './draft-events';
import {
  ProductDraftService,
  type DraftWithImages,
} from './product-draft.service';
import { DraftTelemetry, DraftMetric } from './draft-telemetry';

/**
 * DraftCoordinator — the ORCHESTRATION layer for the two-track product-creation
 * flow (form-filling ∥ image processing). It owns the RENDEZVOUS rule and nothing
 * about persistence (that is ProductDraftService) or messaging (that is
 * TelegramService, via the domain events emitted here).
 *
 * Two entry points, called from the two tracks:
 *   • onFormStep      — the seller answered a questionnaire step (Telegram thread).
 *   • onImageSettled  — an image job reached READY or FAILED (BullMQ worker).
 * Both funnel into `maybeAdvanceToPreview`, which evaluates BOTH axes and, when
 * they meet, flips the draft to READY_FOR_PREVIEW under an optimistic lock and
 * emits `draft.ready_for_preview` exactly once. If the image batch settled with a
 * failure, it emits `draft.images_failed` instead (draft stays CREATING).
 *
 * Concurrency: the form thread and the last image worker can hit this at the same
 * instant. Correctness comes from `ProductDraftService.tryTransition` (versioned,
 * single-winner) — not from locks here. This method is safe to call redundantly.
 */
@Injectable()
export class DraftCoordinator {
  private readonly logger = new Logger(DraftCoordinator.name);
  // Bounds the optimistic-retry loop: re-reads only happen when a concurrent
  // writer bumped the version between our read and our transition. A tiny cap is
  // plenty (at most a handful of racing writers) and prevents any spin.
  private static readonly MAX_TRANSITION_ATTEMPTS = 5;

  constructor(
    private readonly drafts: ProductDraftService,
    private readonly events: EventEmitter2,
    private readonly telemetry: DraftTelemetry,
  ) {}

  /** The seller advanced the questionnaire; re-check the rendezvous. */
  async onFormStep(draftId: string): Promise<void> {
    await this.maybeAdvanceToPreview(draftId);
  }

  /** An image job settled (READY or FAILED); re-check the rendezvous. */
  async onImageSettled(draftId: string): Promise<void> {
    await this.maybeAdvanceToPreview(draftId);
  }

  /**
   * Evaluate both axes and act at the batch boundary:
   *   • draft not CREATING            → nothing to do (already advanced/terminal).
   *   • images still processing       → wait (the settling of the last one re-checks).
   *   • all images settled, ≥1 FAILED → emit images_failed (draft stays CREATING).
   *   • all READY and form complete   → versioned flip to READY_FOR_PREVIEW, emit
   *                                     ready_for_preview (exactly once).
   * The optimistic-retry loop only re-reads when a concurrent writer changed the
   * version underneath us.
   */
  private async maybeAdvanceToPreview(draftId: string): Promise<void> {
    for (
      let attempt = 0;
      attempt < DraftCoordinator.MAX_TRANSITION_ATTEMPTS;
      attempt++
    ) {
      const draft = await this.drafts.findWithImages(draftId);
      if (!draft) return; // deleted/expired-and-swept — nothing to advance
      if (draft.status !== DraftStatus.CREATING) return; // already advanced or terminal

      const images = draft.images;
      const stillProcessing = images.some(
        (img) => img.status === DraftImageStatus.PROCESSING,
      );
      if (stillProcessing) return; // batch not done yet; the last settle re-checks

      const failedCount = images.filter(
        (img) => img.status === DraftImageStatus.FAILED,
      ).length;
      if (failedCount > 0) {
        // Strict all-must-succeed: any failure blocks the preview. Draft (and its
        // form data) is kept; the seller is offered retry/replace/cancel.
        this.emitImagesFailed(draft, failedCount);
        return;
      }

      // All images READY here. Gate on the form axis.
      if (images.length === 0 || !this.isFormComplete(draft)) return;

      const won = await this.drafts.tryTransition(
        draftId,
        DraftStatus.CREATING,
        DraftStatus.READY_FOR_PREVIEW,
        draft.version,
      );
      if (won) {
        this.emitReadyForPreview(draft);
        return;
      }
      // Lost the race: a concurrent writer bumped the version. Re-read and re-decide
      // (they may have moved us to a terminal state, or we still need to advance).
    }
    this.logger.warn(
      `maybeAdvanceToPreview(${draftId}) exhausted retries under version contention`,
    );
  }

  /**
   * The form axis is complete when every REQUIRED field is present. This is
   * field-based (not step-string based) so it is robust regardless of how the FSM
   * labels its final step. Description and part number are optional by design.
   */
  private isFormComplete(draft: DraftWithImages): boolean {
    return (
      draft.title !== null &&
      draft.brand !== null &&
      draft.model !== null &&
      draft.category !== null &&
      draft.priceUzs !== null
    );
  }

  private emitReadyForPreview(draft: DraftWithImages): void {
    const payload: DraftReadyForPreviewEvent = {
      draftId: draft.id,
      tgId: draft.tgId,
    };
    this.telemetry.event('draft.preview_ready', {
      draftId: draft.id,
      sellerId: draft.sellerId,
    });
    this.telemetry.metric(DraftMetric.DRAFT_PREVIEW_EMITTED, {
      draftId: draft.id,
      sellerId: draft.sellerId,
    });
    this.events.emit(DraftEvent.READY_FOR_PREVIEW, payload);
  }

  private emitImagesFailed(draft: DraftWithImages, failedCount: number): void {
    const payload: DraftImagesFailedEvent = {
      draftId: draft.id,
      tgId: draft.tgId,
      failedCount,
    };
    this.logger.warn(
      `Draft ${draft.id}: ${failedCount} image(s) failed after retries`,
    );
    this.events.emit(DraftEvent.IMAGES_FAILED, payload);
  }
}
