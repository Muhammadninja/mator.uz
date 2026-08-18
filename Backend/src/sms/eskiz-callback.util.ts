/**
 * Terminal lifecycle states an SmsMessage can reach from a delivery report.
 * Lower-case to match the `status` values SmsService already writes ('pending')
 * and the `@db.VarChar(20)` column they live in.
 */
export type SmsDeliveryStatus = 'delivered' | 'failed' | 'undelivered';

/**
 * Eskiz delivery-report vocabulary → our three terminal states.
 *
 * Split three ways rather than a delivered/failed binary because the operator
 * distinguishes them and the difference is billable: `failed` is a send the
 * gateway rejected outright, while `undelivered`/`expired` means it was accepted
 * and charged but never reached the handset. Collapsing them would hide that.
 */
const STATUS_MAP: Readonly<Record<string, SmsDeliveryStatus>> = {
  delivered: 'delivered',
  // SMPP's DELIVRD, which Eskiz forwards verbatim from the operator.
  delivrd: 'delivered',
  failed: 'failed',
  rejected: 'failed',
  notdelivered: 'undelivered',
  undelivered: 'undelivered',
  undeliverable: 'undelivered',
  expired: 'undelivered',
};

/**
 * Map a raw Eskiz status onto a terminal state, or null when it is not terminal.
 *
 * A null return is NOT an error: Eskiz posts interim reports too (`waiting`,
 * `accepted`, `transmitted`), and those must leave the row `pending` rather than
 * closing it early — a message reported `waiting` can still end up delivered.
 * An unrecognised status also returns null so an unknown value never
 * mislabels a send; the caller logs it instead.
 */
export function mapEskizStatus(
  raw: string | undefined | null,
): SmsDeliveryStatus | null {
  if (!raw) return null;
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, '');
  return STATUS_MAP[key] ?? null;
}

/** Statuses Eskiz sends that are known-but-not-terminal (row stays `pending`). */
const INTERIM_STATUSES = new Set([
  'waiting',
  'accepted',
  'transmitted',
  'queued',
  'new',
  'sent',
]);

/** True when `raw` is a status we recognise as still in flight. */
export function isInterimStatus(raw: string | undefined | null): boolean {
  if (!raw) return false;
  return INTERIM_STATUSES.has(
    raw
      .trim()
      .toLowerCase()
      .replace(/[\s_-]/g, ''),
  );
}
