// Domain events for the seller lifecycle. SellersService EMITS these;
// TelegramService LISTENS (@OnEvent) and does the actual Telegram messaging.
//
// This mirrors the draft-events seam exactly, and for the same reason: the admin
// console must be able to approve a seller without depending on Telegraf. The
// admin module knows nothing about the bot — it changes a status, and whoever
// cares reacts. That also keeps the notification automatic for EVERY approval
// path (the admin API today, any future console or script tomorrow), because the
// event is emitted at the single status-write chokepoint rather than at a call
// site someone could forget.

/** Event name constants (dot-namespaced, the EventEmitter2 convention). */
export const SellerEvent = {
  /** A seller just transitioned INTO the ACTIVE status — i.e. was approved.
   *  Emitted exactly once per approval: a repeat write of an already-ACTIVE
   *  seller does not re-emit, so re-approving cannot re-notify. */
  APPROVED: 'seller.approved',
} as const;

/** Payload for `seller.approved`. `tgId` doubles as the Telegram chat id. */
export interface SellerApprovedEvent {
  sellerId: number;
  tgId: bigint;
}
