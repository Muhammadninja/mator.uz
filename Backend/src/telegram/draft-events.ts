// Domain events for the product-draft lifecycle. DraftCoordinator EMITS these;
// TelegramService LISTENS (@OnEvent) and does the actual Telegram messaging. This
// is the seam that keeps the image worker free of any Telegram dependency: the
// worker calls the coordinator, the coordinator emits, the bot reacts — no direct
// worker→Telegraf coupling and no second transport.

/** Event name constants (dot-namespaced, the EventEmitter2 convention). */
export const DraftEvent = {
  /** Both tracks are done: the draft just flipped CREATING → READY_FOR_PREVIEW.
   *  Emitted exactly once per draft (guarded by the optimistic-locked transition). */
  READY_FOR_PREVIEW: 'draft.ready_for_preview',
  /** At least one image failed after exhausting retries. The draft stays CREATING
   *  and its form data is intact; the seller is offered retry / replace / cancel. */
  IMAGES_FAILED: 'draft.images_failed',
} as const;

/** Payload for `draft.ready_for_preview`. Carries the ids the listener needs to
 *  load the draft and message the seller (tgId doubles as the chat id). */
export interface DraftReadyForPreviewEvent {
  draftId: string;
  tgId: bigint;
}

/** Payload for `draft.images_failed`. `failedCount` lets the notice be specific. */
export interface DraftImagesFailedEvent {
  draftId: string;
  tgId: bigint;
  failedCount: number;
}
