/**
 * The alert vocabulary shared by the queue monitor (producer) and the alert
 * service (dispatcher). Deliberately transport-agnostic: nothing here knows how
 * an alert is delivered, which is what lets a Telegram/email/Prometheus channel
 * be added later without touching detection logic.
 */

/** What went wrong. One value per detectable condition. */
export const ALERT_TYPES = {
  /** Failed job count for a queue is at/above QUEUE_ALERT_FAILED_THRESHOLD. */
  FAILED_JOBS: 'failed_jobs',
  /** `waiting` grew on every one of the last N samples and is above the floor. */
  WAITING_GROWING: 'waiting_growing',
  /** Jobs are waiting but the queue has no active worker to consume them. */
  NO_ACTIVE_WORKERS: 'no_active_workers',
  /** A queue could not be sampled (Redis error) — the monitor itself degraded. */
  MONITOR_ERROR: 'monitor_error',
  // Raised by the money side (src/orders/finance-alerts.ts), under the "queue" `payments`.
  /** Payme reports a fiscal receipt the tax authority did not accept. */
  FISCAL_RECEIPT_FAILED: 'fiscal_receipt_failed',
  /** A fiscal receipt contradicts the accepted one on file, or comes where none should. */
  FISCAL_RECEIPT_CONFLICT: 'fiscal_receipt_conflict',
  /** Payme asked to refund a payment and the refund was refused. */
  REFUND_REFUSED: 'refund_refused',
  /** Money went back outside Payme and no return receipt is confirmed. */
  REFUND_RECEIPT_UNCONFIRMED: 'refund_receipt_unconfirmed',
} as const;

export type AlertType = (typeof ALERT_TYPES)[keyof typeof ALERT_TYPES];

/** How loudly to report. Maps onto log levels today, channel routing later. */
export type AlertSeverity = 'warning' | 'critical';

export interface Alert {
  type: AlertType;
  severity: AlertSeverity;
  /** The queue this alert concerns. */
  queue: string;
  /** Human-readable one-liner — the message an operator reads first. */
  message: string;
  /**
   * Structured detail (counts, thresholds, worker counts). Kept separate from
   * `message` so a future channel can format or export it without re-parsing text.
   */
  context: Record<string, unknown>;
  /** When the condition was observed. */
  firedAt: Date;
}

/**
 * A delivery destination for alerts. Implement this and register it with
 * AlertService to add Telegram, email, PagerDuty, etc.
 *
 * Contract: `deliver` must not throw — AlertService isolates failures, but a
 * channel that swallows its own errors keeps the logs honest about whose fault
 * a delivery failure is.
 */
export interface AlertChannel {
  /** Identifier used in logs when a delivery fails. */
  readonly name: string;
  deliver(alert: Alert): Promise<void> | void;
}

/**
 * The dedupe identity of an alert: same type + same queue is "the same alert"
 * for cooldown purposes. Distinct queues alert independently, so a backlog on
 * `sms` never masks one on `image-processing`.
 */
export function alertKey(alert: Pick<Alert, 'type' | 'queue'>): string {
  return `${alert.type}:${alert.queue}`;
}
