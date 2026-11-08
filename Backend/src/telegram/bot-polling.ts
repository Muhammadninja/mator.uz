import type { Logger } from '@nestjs/common';
import {
  CONFLICT_STABLE_MS,
  DuplicatePollingLoopError,
  WebhookSetError,
  conflictCause,
  conflictPausedMessage,
  conflictRetryDelayMs,
  describeConflictCause,
  type ConflictPolicy,
} from './polling-conflict';
import type {
  ConflictCause,
  PollingConflictView,
  PollingErrorKind,
  PollingFacts,
  PollingFactsSource,
  PollingFailedReason,
  PollingState,
} from './polling-status';

import {
  INCOMPATIBLE_TELEGRAF,
  type ConnectApi,
  type PollableBot,
  type StartPolling,
  classifyPollingError,
  errorForLog,
  observeGetUpdates,
  pollingErrorKind,
  pollingRetryDelayMs,
  unauthorizedMessage,
} from './polling-policy';

export type { PollingState } from './polling-status';
// Moved to polling-policy.ts; re-exported so importers are unchanged.
export {
  SUPPORTED_TELEGRAF_VERSION,
  POLLING_RETRY_BASE_MS,
  POLLING_RETRY_MAX_MS,
  classifyPollingError,
  errorForLog,
  pollingErrorKind,
  pollingRetryDelayMs,
  redactBotToken,
  type PollingFailureKind,
} from './polling-policy';

/**
 * The seller bot's long-polling lifecycle: start, retry, report, stop.
 *
 * Polling-only; the webhook is never changed. Telegraf's launch() is NOT used
 * (it calls deleteWebhook on every start): the connect is getMe → read-only
 * getWebhookInfo → Telegraf's startPolling, and a webhook that is set is a
 * conflict to wait out (polling-conflict.ts). The loop settles only when
 * polling ENDS; Telegraf never restarts it. It ends for good when:
 *   • the getMe / getWebhookInfo the connect begins with fail — e.g.
 *     api.telegram.org briefly unreachable at boot (only getUpdates is retried
 *     inside Telegraf);
 *   • getUpdates answers 401 (token revoked) or 409 (another poller, or a
 *     webhook, owns this token's updates);
 *   • an error escapes an update handler — prevented by the `bot.catch` that
 *     TelegramService registers before anything can run.
 * The process stays up in every case, which is how the bot used to go
 * permanently deaf with one log line to show for it.
 *
 * Policy: exactly one connect — and one polling loop — at a time; a transient
 * failure is retried with capped exponential backoff; a 409 conflict pauses
 * polling and is re-checked on a slow backoff until it is gone (see
 * polling-conflict.ts); any other permanent failure is reported once, loudly,
 * and NOT retried — retrying a bad token would only bury a configuration
 * problem under a stream of warnings. Nothing restarts after stop().
 */

type PollingLogger = Pick<Logger, 'log' | 'warn' | 'error'>;

/** Why a launch that shutdown overtook ends without ever polling. */
const SHUTDOWN_BEFORE_POLLING =
  'shutdown requested before long polling started';

export class BotPollingSupervisor implements PollingFactsSource {
  private state: PollingState = 'idle';
  /** When `state` was entered (epoch ms). */
  private stateSince = Date.now();
  /** Consecutive failed launches since polling last started. */
  private failures = 0;
  private retryTimer: NodeJS.Timeout | undefined;
  private stopRequested = false;
  /** Why this bot cannot be supervised (see observePollingStart). */
  private readonly incompatibility: string | undefined;
  // What the status report needs beyond `state` — see pollingFacts().
  private loopStartedAt: number | undefined;
  private lastPollAt: number | undefined;
  private lastUpdateAt: number | undefined;
  private lastErrorAt: number | undefined;
  private lastError: PollingErrorKind | undefined;
  private nextAttemptAt: number | undefined;
  private failedReason: PollingFailedReason | undefined;
  /** Follows a failure; cleared by the first getUpdates that answers. */
  private recovering = false;
  /** The current 409 incident, from the first 409 until polling is stable. */
  private conflict: PollingConflictView | undefined;
  /** A getUpdates loop of this bot is running (see observePollingStart). */
  private loopActive = false;
  private readonly conflictDelay: (attempt: number) => number;
  private readonly conflictStableMs: number;

  constructor(
    private readonly bot: PollableBot,
    private readonly logger: PollingLogger,
    /** Delay before retry N (1-based). Production keeps the default; tests
     *  shorten it. */
    private readonly retryDelay: (
      failures: number,
      err: unknown,
    ) => number = pollingRetryDelayMs,
    conflict: ConflictPolicy = {},
  ) {
    this.conflictDelay = conflict.delay ?? ((n) => conflictRetryDelayMs(n));
    this.conflictStableMs = conflict.stableMs ?? CONFLICT_STABLE_MS;
    this.incompatibility = this.observePollingStart();
    observeGetUpdates(this.bot.telegram, {
      answered: (updates) => this.onPollAnswered(updates),
      failed: (err) => this.onPollFailed(err),
    });
  }

  get status(): PollingState {
    return this.state;
  }

  /** The facts /health and the metrics derive the public status from. */
  pollingFacts(): PollingFacts {
    return {
      state: this.state,
      since: this.stateSince,
      loopStartedAt: this.loopStartedAt,
      lastPollAt: this.lastPollAt,
      lastUpdateAt: this.lastUpdateAt,
      lastErrorAt: this.lastErrorAt,
      lastError: this.lastError,
      nextAttemptAt: this.nextAttemptAt,
      consecutiveFailures: this.failures,
      failedReason: this.failedReason,
      recovering: this.recovering,
      conflict: this.conflict && { ...this.conflict },
    };
  }

  private setState(state: PollingState): void {
    if (state !== this.state) this.stateSince = Date.now();
    this.state = state;
    if (state !== 'retrying' && state !== 'conflict') {
      this.nextAttemptAt = undefined;
    }
  }

  /**
   * Connect and poll unless already starting/polling/in conflict, shut down,
   * or unsupervisable. Never throws; every ending goes to onEnded / onFailed.
   */
  start(): void {
    if (
      this.stopRequested ||
      this.state === 'starting' ||
      this.state === 'polling' ||
      // Only the conflict re-check resumes from a conflict, so no second
      // connect can run beside it (see polling-conflict.ts).
      this.state === 'conflict'
    ) {
      return;
    }
    if (this.incompatibility !== undefined) {
      // Nothing a retry could change: reported once, and never started — an
      // unguarded loop could not be kept from starting after shutdown.
      if (this.state !== 'failed') {
        this.fail('incompatible', this.incompatibility);
      }
      return;
    }
    this.clearRetryTimer();
    this.setState('starting');
    this.logger.log(
      this.failures === 0
        ? 'Bot starting (long polling)...'
        : `Bot starting (long polling)... retry ${this.failures}`,
    );
    this.run(() => this.connect());
  }

  /**
   * launch() minus its deleteWebhook: getMe (once; botInfo is kept), a
   * READ-ONLY webhook check, then startPolling. A webhook that is set rejects
   * with WebhookSetError (→ conflict): it is not ours to delete.
   */
  private async connect(): Promise<void> {
    const api = this.bot.telegram as ConnectApi;
    this.bot.botInfo ??= await api.getMe();
    this.onConnected();
    const webhook = await api.getWebhookInfo();
    if (this.stopRequested) throw new Error(SHUTDOWN_BEFORE_POLLING);
    if (webhook?.url) throw new WebhookSetError();
    const bot = this.bot as unknown as { startPolling: StartPolling };
    await bot.startPolling();
  }

  /** Run one connect or loop; every way it ends goes to onEnded / onFailed. */
  private run(begin: () => Promise<void>): void {
    let attempt: Promise<void>;
    try {
      attempt = begin(); // synchronously: start() is then already in flight
    } catch (err) {
      attempt = Promise.reject(
        err instanceof Error ? err : new Error(String(err)),
      );
    }
    attempt
      .then(
        () => this.onEnded(),
        (err: unknown) => this.onFailed(err),
      )
      .catch((err: unknown) => this.reportSupervisorFailure(err));
  }

  /** Never silent, never an unhandled rejection (main.ts exits on one). */
  private reportSupervisorFailure(err: unknown): void {
    try {
      const { message, stack } = errorForLog(err);
      this.logger.error(`Bot polling supervisor failed: ${message}`, stack);
    } catch {
      // Logging itself failed; nothing safer is left to do.
    }
  }

  /**
   * Stop for good (application shutdown): no retry is pending afterwards and
   * none will be scheduled. Never throws.
   */
  stop(): void {
    this.stopRequested = true;
    this.clearRetryTimer();
    const running = this.state === 'starting' || this.state === 'polling';
    this.setState('stopped');
    if (!running) return;
    try {
      this.bot.stop('shutdown');
    } catch {
      // Telegraf refuses ("Bot is not running!") while the connect is still
      // running: no loop exists yet. The connect is turned away at its next
      // step instead (onConnected, the webhook check or the wrapped startPolling).
    }
  }

  /**
   * Telegraf 4.16's (private) startPolling() creates and runs the getUpdates
   * loop; connect() and the conflict re-check call it, never launch(). It is
   * wrapped on this bot instance because:
   *   • it is when polling really begins. A successful getMe is not: the
   *     webhook check after it can still fail, and resetting the backoff there
   *     would keep a failing connect retrying at the base delay forever;
   *   • it is the last point at which a shutdown can stop a connect already
   *     past getMe, since Telegraf's stop() refuses until the loop exists;
   *   • it is where the one-loop-at-a-time rule is enforced.
   * There is deliberately NO fallback: without the step, Telegraf is
   * incompatible and never started. Returns that verdict, or undefined.
   */
  private observePollingStart(): string | undefined {
    const bot = this.bot as unknown as { startPolling?: StartPolling };
    const startPolling = bot.startPolling;
    if (typeof startPolling !== 'function') {
      return INCOMPATIBLE_TELEGRAF;
    }
    bot.startPolling = (...args: unknown[]) => {
      if (this.stopRequested) {
        return Promise.reject(new Error(SHUTDOWN_BEFORE_POLLING));
      }
      // One loop per bot: a second one would make this process its own 409.
      if (this.loopActive) {
        return Promise.reject(new DuplicatePollingLoopError());
      }
      this.loopActive = true;
      this.onPollingStarted();
      try {
        return (startPolling.apply(this.bot, args) as Promise<void>).finally(
          () => {
            this.loopActive = false;
          },
        );
      } catch (err) {
        this.loopActive = false;
        throw err;
      }
    };
    return undefined;
  }

  private onPollAnswered(updates: unknown): void {
    const now = Date.now();
    this.lastPollAt = now;
    if (Array.isArray(updates) && updates.length > 0) this.lastUpdateAt = now;
    if (this.recovering && this.conflict) {
      this.logger.log(
        'Bot polling resumed after the conflict — getUpdates answered',
      );
    }
    this.recovering = false;
    if (
      this.conflict &&
      this.loopStartedAt !== undefined &&
      now - this.loopStartedAt >= this.conflictStableMs
    ) {
      this.logger.log(
        `Bot polling conflict resolved — no 409 for ${Math.round(
          (now - this.loopStartedAt) / 1000,
        )}s after ${this.conflict.attempts} conflict check(s)`,
      );
      this.conflict = undefined;
    }
  }

  private onPollFailed(err: unknown): void {
    // Shutdown aborts the pending long poll; that is not a failure.
    if (err instanceof Error && err.name === 'AbortError') return;
    this.lastErrorAt = Date.now();
    this.lastError = pollingErrorKind(err);
  }

  private onConnected(): void {
    // Once getMe has answered — BEFORE the webhook check and the loop: the
    // token works, but nothing is polled yet, so nothing is reported active
    // here. A shutdown that raced the connect is turned away here. Throwing
    // makes the connect reject (→ onFailed).
    if (this.stopRequested) throw new Error(SHUTDOWN_BEFORE_POLLING);
  }

  private onPollingStarted(): void {
    this.setState('polling');
    this.loopStartedAt = Date.now();
    // The whole connect succeeded — getMe AND the webhook check — so the next
    // failure is a new incident, backed off from the start again.
    this.failures = 0;
    this.logger.log(
      `Bot connected as @${this.bot.botInfo?.username ?? 'unknown'} — long polling active`,
    );
  }

  private onEnded(): void {
    if (this.stopRequested) {
      this.logger.log('Bot stopped (long polling ended)');
      return;
    }
    // Only stop() ends a healthy loop, and nothing else calls it — so an
    // unprompted end is handled like any other transient failure.
    this.retryLater(new Error('long polling ended unexpectedly'));
  }

  private onFailed(err: unknown): void {
    const { message, stack } = errorForLog(err);
    if (this.stopRequested) {
      this.logger.log(`Bot stopped (${message})`);
      return;
    }
    if (err instanceof WebhookSetError) {
      this.onConflict('webhook', describeConflictCause('webhook'));
      return;
    }
    if (err instanceof DuplicatePollingLoopError) {
      // The running loop's own handlers own the state; nothing to change.
      this.logger.error(
        `Bot polling: refused to start a second loop (${message})`,
      );
      return;
    }
    switch (classifyPollingError(err)) {
      case 'unauthorized':
        this.fail('unauthorized', unauthorizedMessage(message));
        return;
      case 'conflict':
        this.onConflict(conflictCause(err), message);
        return;
      case 'rejected':
        this.fail(
          'rejected',
          `Telegram refused the polling request (${message}). Not retrying: ` +
            'this needs a configuration or code fix.',
          stack,
        );
        return;
      case 'transient':
        this.retryLater(err);
    }
  }

  /** A 409 — from the loop, or found again by a re-check. */
  private onConflict(cause: ConflictCause, why: string): void {
    const first = this.conflict === undefined;
    this.conflict ??= { cause, since: Date.now(), attempts: 0 };
    this.conflict.cause = cause;
    this.conflict.attempts += 1;
    const delayMs = this.conflictDelay(this.conflict.attempts);
    this.setState('conflict');
    this.nextAttemptAt = Date.now() + delayMs;
    this.recovering = true;
    if (first) {
      this.logger.error(conflictPausedMessage(why, cause, delayMs));
    } else {
      this.logger.warn(
        `Bot polling still in conflict (${why}) — check ${this.conflict.attempts} in ${Math.ceil(delayMs / 1000)}s`,
      );
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.checkConflict();
    }, delayMs);
    this.retryTimer.unref?.();
  }

  /**
   * One re-check: a read-only getWebhookInfo. A webhook still set → keep
   * waiting; none → restart the loop (Telegraf's own step, so neither getMe
   * nor deleteWebhook runs again). Never throws; no check, no resume.
   */
  private checkConflict(): void {
    if (this.stopRequested || this.state !== 'conflict') return;
    const api = this.bot.telegram as ConnectApi;
    const stillConflicting = () =>
      this.stopRequested || this.state !== 'conflict';
    Promise.resolve()
      .then(() => api.getWebhookInfo())
      .then(
        (info) => {
          if (stillConflicting()) return;
          if (info?.url) {
            this.onConflict('webhook', describeConflictCause('webhook'));
            return;
          }
          this.resumeAfterConflict();
        },
        (err: unknown) => {
          if (stillConflicting()) return;
          const { message } = errorForLog(err);
          if (classifyPollingError(err) === 'unauthorized') {
            this.fail('unauthorized', unauthorizedMessage(message));
            return;
          }
          this.onConflict(
            this.conflict?.cause ?? 'unknown',
            `the webhook check failed: ${message}`,
          );
        },
      )
      .catch((err: unknown) => this.reportSupervisorFailure(err));
  }

  private resumeAfterConflict(): void {
    this.logger.log(
      `No webhook is set — resuming long polling after the conflict (check ${
        this.conflict?.attempts ?? 0
      })`,
    );
    this.setState('starting');
    const bot = this.bot as unknown as { startPolling: StartPolling };
    this.run(() => bot.startPolling());
  }

  private fail(
    kind: PollingFailedReason,
    reason: string,
    stack?: string,
  ): void {
    this.setState('failed');
    this.failedReason = kind;
    this.logger.error(`Bot polling STOPPED — ${reason}`, stack);
  }

  private retryLater(err: unknown): void {
    this.failures += 1;
    const delayMs = this.retryDelay(this.failures, err);
    this.setState('retrying');
    this.nextAttemptAt = Date.now() + delayMs;
    this.recovering = true;
    this.logger.warn(
      `Bot polling failed (${errorForLog(err).message}) — retry ${this.failures} ` +
        `in ${Math.ceil(delayMs / 1000)}s`,
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.start();
    }, delayMs);
    // The HTTP server keeps the process alive; a pending retry alone must not.
    this.retryTimer.unref?.();
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }
}
