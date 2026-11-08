import { Global, Injectable, Module } from '@nestjs/common';

/**
 * The seller bot's polling status as /health and the metrics report it.
 *
 * Kept free of Telegraf and of TelegramService on purpose: HealthController and
 * the metrics collector read it, and neither should pull the bot (and its whole
 * dependency graph) in just to say whether it is polling. BotPollingSupervisor
 * owns the facts; TelegramPollingStatus only hands them out.
 *
 * Nothing here ever carries the bot token, a chat id, a username or an error
 * message: only enums, counts and timestamps.
 */

/**
 * The supervisor's own lifecycle state (see bot-polling.ts).
 *   idle      — constructed, never started
 *   starting  — connect in flight (getMe → getWebhookInfo); nothing polled yet
 *   polling   — Telegraf's getUpdates loop exists
 *   retrying  — after a transient failure; the next launch is scheduled
 *   conflict  — Telegram answered 409; polling is paused until a re-check
 *   failed    — after a permanent failure, or on an incompatible Telegraf;
 *               nothing will restart it
 *   stopped   — shut down
 */
export type PollingState =
  | 'idle'
  | 'starting'
  | 'polling'
  | 'retrying'
  | 'conflict'
  | 'failed'
  | 'stopped';

/** What /health and the metrics say. */
export type PublicPollingStatus = 'running' | 'stopped' | 'error' | 'starting';

export const PUBLIC_POLLING_STATUSES: readonly PublicPollingStatus[] = [
  'running',
  'stopped',
  'error',
  'starting',
];

/** Why polling is not simply `running`. */
export type PollingStatusReason =
  | 'disabled' // TELEGRAM_POLLING_DISABLED=true on this instance
  | 'not_started'
  | 'shutdown'
  | 'launching' // first start; no getUpdates has answered yet
  | 'recovering' // restarting after a failure or a conflict
  | 'transient_failure' // waiting out a backoff before the next launch
  | 'conflict' // 409: another poller or a webhook owns the updates
  | 'unauthorized'
  | 'rejected'
  | 'incompatible'
  | 'stalled'; // the loop exists but getUpdates has not answered for too long

/** Permanent failures — nothing restarts polling after one of these. */
export type PollingFailedReason = 'unauthorized' | 'rejected' | 'incompatible';

/** The kind of the last getUpdates failure, for diagnosis. */
export type PollingErrorKind =
  | 'network'
  | 'rate_limited'
  | 'server_error'
  | 'conflict'
  | 'unauthorized'
  | 'rejected';

/** Who holds the updates during a 409. */
export type ConflictCause = 'other_poller' | 'webhook' | 'unknown';

export interface PollingConflictView {
  cause: ConflictCause;
  /** When the current conflict began (epoch ms). */
  since: number;
  /** Consecutive 409s / re-checks in this incident. */
  attempts: number;
}

/** The raw facts the supervisor records. Times are epoch ms. */
export interface PollingFacts {
  state: PollingState;
  /** When `state` was entered. */
  since: number;
  /** When the current getUpdates loop started. */
  loopStartedAt?: number;
  /** The last getUpdates that answered — with or without updates. */
  lastPollAt?: number;
  /** The last getUpdates that delivered at least one update. */
  lastUpdateAt?: number;
  lastErrorAt?: number;
  lastError?: PollingErrorKind;
  /** When the next launch / conflict re-check is due. */
  nextAttemptAt?: number;
  consecutiveFailures: number;
  failedReason?: PollingFailedReason;
  /** The current launch / loop follows a failure or a conflict. */
  recovering: boolean;
  /** Present from the first 409 until polling has been stable again. */
  conflict?: PollingConflictView;
}

export interface PollingSnapshot {
  status: PublicPollingStatus;
  /** null exactly when `status` is `running`. */
  reason: PollingStatusReason | null;
  since: number;
  lastPollAt: number | null;
  lastUpdateAt: number | null;
  lastErrorAt: number | null;
  lastError: PollingErrorKind | null;
  nextAttemptAt: number | null;
  consecutiveFailures: number;
  conflict: PollingConflictView | null;
}

/**
 * A healthy long poll answers at least every 50 s (Telegraf's getUpdates
 * timeout), and Telegraf waits for a whole batch — each update up to its 90 s
 * handler timeout — before it polls again. Past this much silence the loop is
 * not getting answers: Telegram unreachable (Telegraf retries that inside its
 * loop, unseen), or a batch that never finishes.
 */
export const POLLING_STALE_AFTER_MS = 180_000;

/** The public status that `facts` amount to at `now`. */
export function derivePollingSnapshot(
  facts: PollingFacts,
  now: number,
  staleAfterMs: number = POLLING_STALE_AFTER_MS,
): PollingSnapshot {
  const [status, reason] = publicStatus(facts, now, staleAfterMs);
  return {
    status,
    reason,
    since: facts.since,
    lastPollAt: facts.lastPollAt ?? null,
    lastUpdateAt: facts.lastUpdateAt ?? null,
    lastErrorAt: facts.lastErrorAt ?? null,
    lastError: facts.lastError ?? null,
    nextAttemptAt: facts.nextAttemptAt ?? null,
    consecutiveFailures: facts.consecutiveFailures,
    conflict: facts.conflict ? { ...facts.conflict } : null,
  };
}

function publicStatus(
  facts: PollingFacts,
  now: number,
  staleAfterMs: number,
): [PublicPollingStatus, PollingStatusReason | null] {
  const starting: PollingStatusReason = facts.recovering
    ? 'recovering'
    : 'launching';
  switch (facts.state) {
    case 'idle':
      return ['stopped', 'not_started'];
    case 'stopped':
      return ['stopped', 'shutdown'];
    case 'starting':
      return ['starting', starting];
    case 'retrying':
      return ['error', 'transient_failure'];
    case 'conflict':
      return ['error', 'conflict'];
    case 'failed':
      return ['error', facts.failedReason ?? 'rejected'];
    case 'polling': {
      const loopStart = facts.loopStartedAt ?? facts.since;
      // Only an answer to THIS loop's getUpdates counts.
      const answered =
        facts.lastPollAt !== undefined && facts.lastPollAt >= loopStart
          ? facts.lastPollAt
          : undefined;
      if (now - (answered ?? loopStart) > staleAfterMs) {
        return ['error', 'stalled'];
      }
      // A loop is "running" once Telegram has answered it, not before: a
      // getUpdates that is still pending may yet come back 409.
      return answered === undefined
        ? ['starting', starting]
        : ['running', null];
    }
  }
}

/** The JSON shape served by /health/telegram: ISO times, nothing secret. */
export function pollingHealthView(snapshot: PollingSnapshot) {
  const iso = (ms: number | null) =>
    ms === null ? null : new Date(ms).toISOString();
  return {
    status: snapshot.status,
    reason: snapshot.reason,
    since: iso(snapshot.since),
    lastPollAt: iso(snapshot.lastPollAt),
    lastUpdateAt: iso(snapshot.lastUpdateAt),
    lastErrorAt: iso(snapshot.lastErrorAt),
    lastError: snapshot.lastError,
    nextAttemptAt: iso(snapshot.nextAttemptAt),
    consecutiveFailures: snapshot.consecutiveFailures,
    conflict: snapshot.conflict && {
      cause: snapshot.conflict.cause,
      since: iso(snapshot.conflict.since),
      attempts: snapshot.conflict.attempts,
    },
  };
}

/** What can report polling facts — BotPollingSupervisor. */
export interface PollingFactsSource {
  pollingFacts(): PollingFacts;
}

/**
 * The process-wide handle on the bot's polling status. TelegramService attaches
 * its supervisor (or marks polling disabled) during onModuleInit; HealthController
 * and the metrics collector read it.
 */
@Injectable()
export class TelegramPollingStatus {
  private source: PollingFactsSource | undefined;
  private disabledSince: number | undefined;
  private readonly createdAt = Date.now();

  attach(source: PollingFactsSource): void {
    this.source = source;
    this.disabledSince = undefined;
  }

  /** This instance never polls (TELEGRAM_POLLING_DISABLED=true). */
  markDisabled(now: number = Date.now()): void {
    this.source = undefined;
    this.disabledSince = now;
  }

  current(now: number = Date.now()): PollingSnapshot {
    if (this.source)
      return derivePollingSnapshot(this.source.pollingFacts(), now);
    const snapshot = derivePollingSnapshot(
      {
        state: 'idle',
        since: this.disabledSince ?? this.createdAt,
        consecutiveFailures: 0,
        recovering: false,
      },
      now,
    );
    if (this.disabledSince !== undefined) snapshot.reason = 'disabled';
    return snapshot;
  }
}

/**
 * Global so TelegramService, HealthController and the metrics collector share
 * ONE instance without importing each other's modules.
 */
@Global()
@Module({
  providers: [TelegramPollingStatus],
  exports: [TelegramPollingStatus],
})
export class TelegramPollingStatusModule {}
