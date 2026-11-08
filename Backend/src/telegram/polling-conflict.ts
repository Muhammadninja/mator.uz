import { TelegramError } from 'telegraf';
import type { ConflictCause } from './polling-status';

/**
 * What the seller bot does on `409 Conflict` — pure policy; the lifecycle that
 * applies it is BotPollingSupervisor (bot-polling.ts).
 *
 * Telegram answers getUpdates with 409 when it is not ours to call: another
 * process is long-polling the same token ("terminated by other getUpdates
 * request"), or a webhook is set ("can't use getUpdates method while webhook
 * is active"). Both are external. The app never ends them itself — it neither
 * touches the other process nor deletes the webhook nor changes any Telegram
 * setting. It pauses polling, re-checks on a slow capped backoff, and resumes
 * by itself once the conflict is gone.
 *
 * The same holds at every start: the connect checks getWebhookInfo before it
 * polls, and a webhook found there is a conflict too (deleteWebhook is never
 * called, Telegraf's launch() is not used — see bot-polling.ts).
 *
 * A re-check is ONE read-only getWebhookInfo. While a webhook is set, polling
 * stays paused. With none set, the only way to learn whether another poller is
 * still there is to poll: the loop is restarted (Telegraf's startPolling, no
 * getMe) and a new 409 sends it back to waiting, a longer wait each time. The backoff only resets once polling has run CONFLICT_STABLE_MS without
 * another 409, so two pollers can never settle into a fast tug of war.
 */

/** The first re-check waits this long; each consecutive conflict doubles it… */
export const CONFLICT_RETRY_BASE_MS = 30_000;
/** …up to this ceiling: at worst one re-check every ~5 minutes. */
export const CONFLICT_RETRY_MAX_MS = 300_000;
/** Up to this fraction is added at random, so two instances of this app that
 *  conflict with each other drift apart instead of re-checking in lockstep. */
export const CONFLICT_RETRY_JITTER = 0.2;
/** Polling must run this long without a 409 before the conflict counts as
 *  over (and the backoff starts from the base again). */
export const CONFLICT_STABLE_MS = 120_000;

/** Overrides for the supervisor's conflict policy (tests shorten it). */
export interface ConflictPolicy {
  /** Delay before conflict re-check N (1-based). */
  delay?: (attempt: number) => number;
  /** How long polling must run without a 409 for the conflict to be over. */
  stableMs?: number;
}

/** The connect found a webhook set for this token: polling is not started. */
export class WebhookSetError extends Error {
  constructor() {
    super(describeConflictCause('webhook'));
  }
}

/** A second polling loop of the same bot was refused: one at a time, or this
 *  process would be its own 409. */
export class DuplicatePollingLoopError extends Error {
  constructor() {
    super('a polling loop is already running in this process');
  }
}

/** Delay before conflict re-check `attempt` (1-based). */
export function conflictRetryDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const backoff = Math.min(
    CONFLICT_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1),
    CONFLICT_RETRY_MAX_MS,
  );
  return Math.round(backoff * (1 + CONFLICT_RETRY_JITTER * random()));
}

/** Who holds the updates, from Telegram's own description of the 409. */
export function conflictCause(err: unknown): ConflictCause {
  const text = (
    err instanceof TelegramError ? err.description : String(err)
  ).toLowerCase();
  if (text.includes('webhook')) return 'webhook';
  if (text.includes('other getupdates')) return 'other_poller';
  return 'unknown';
}

export function describeConflictCause(cause: ConflictCause): string {
  switch (cause) {
    case 'webhook':
      return 'a webhook is set for this bot token';
    case 'other_poller':
      return 'another process is polling this bot token';
    case 'unknown':
      return 'another process is polling this bot token, or a webhook is set for it';
  }
}

/** The one loud log line that opens a conflict incident. */
export function conflictPausedMessage(
  why: string,
  cause: ConflictCause,
  delayMs: number,
): string {
  return (
    `Bot polling PAUSED — Telegram reports a conflict (${why}): ` +
    `${describeConflictCause(cause)}. Not fighting it: no webhook is deleted ` +
    `and no other process is touched. Re-checking in ${Math.ceil(delayMs / 1000)}s, ` +
    `then on a backoff of up to ${CONFLICT_RETRY_MAX_MS / 1000}s; polling resumes ` +
    'by itself once the conflict is gone. To end it: stop the other poller ' +
    '(every non-production instance must set TELEGRAM_POLLING_DISABLED=true) ' +
    'or remove the webhook.'
  );
}
