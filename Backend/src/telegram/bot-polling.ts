import type { Logger } from '@nestjs/common';
import { TelegramError, type Context, type Telegraf } from 'telegraf';

/**
 * The seller bot's long-polling lifecycle: start, retry, report, stop.
 *
 * `bot.launch()` returns a promise that settles only when polling ENDS, and
 * Telegraf never restarts polling by itself. It ends for good when:
 *   • the getMe / deleteWebhook that launch() begins with fail — e.g.
 *     api.telegram.org briefly unreachable at boot (only getUpdates is retried
 *     inside Telegraf);
 *   • getUpdates answers 401 (token revoked) or 409 (another poller, or a
 *     webhook, owns this token's updates);
 *   • an error escapes an update handler — prevented by the `bot.catch` that
 *     TelegramService registers before anything can run.
 * The process stays up in every case, which is how the bot used to go
 * permanently deaf with one log line to show for it.
 *
 * Policy: exactly one launch at a time; a transient failure is retried with
 * capped exponential backoff; a permanent one is reported once, loudly, and NOT
 * retried — retrying a bad token or a duplicate poller would only bury a
 * configuration problem under a stream of warnings. Nothing restarts after stop().
 */

/**
 * The Telegraf release this lifecycle is built and tested on. It hooks a step
 * of Telegraf's own launch() (see observePollingStart), so package.json pins
 * exactly this version; telegram.polling.spec.ts fails should the pin, the
 * lockfile, the installed package and this constant ever disagree.
 */
export const SUPPORTED_TELEGRAF_VERSION = '4.16.3';

/**
 * How a failed launch is handled:
 *   transient    — no answer from Telegram (DNS, refused/reset connection,
 *                  timeout) or a 429/5xx: retried with backoff;
 *   unauthorized — 401/404: the token is revoked or malformed;
 *   conflict     — 409: another process polls this token, or a webhook is set;
 *   rejected     — any other 4xx: Telegram refuses the request as made.
 * Only `transient` is ever retried.
 */
export type PollingFailureKind =
  'transient' | 'unauthorized' | 'conflict' | 'rejected';

export function classifyPollingError(err: unknown): PollingFailureKind {
  if (!(err instanceof TelegramError)) return 'transient';
  if (err.code === 401 || err.code === 404) return 'unauthorized';
  if (err.code === 409) return 'conflict';
  if (err.code === 429 || err.code >= 500) return 'transient';
  return 'rejected';
}

/** The first retry waits this long; each consecutive failure doubles it… */
export const POLLING_RETRY_BASE_MS = 2_000;
/** …up to this ceiling, so a long outage is probed about once a minute. */
export const POLLING_RETRY_MAX_MS = 60_000;

/**
 * Delay before retry number `failures` (1-based): capped exponential backoff,
 * stretched to Telegram's own `retry_after` when a 429 states one — retrying
 * sooner than that only earns another 429.
 */
export function pollingRetryDelayMs(failures: number, err?: unknown): number {
  const backoff = Math.min(
    POLLING_RETRY_BASE_MS * 2 ** Math.max(0, failures - 1),
    POLLING_RETRY_MAX_MS,
  );
  const retryAfterS =
    err instanceof TelegramError ? err.parameters?.retry_after : undefined;
  return retryAfterS === undefined
    ? backoff
    : Math.max(backoff, retryAfterS * 1000);
}

/**
 * Strip a bot token (`<bot id>:<secret>`) from text bound for the logs.
 *
 * Telegraf already redacts the token from a failed request's MESSAGE, but an
 * error's `stack` is a separate string, fixed the first time it is read — if
 * anything read it before Telegraf's redaction, it still carries the request
 * URL, token included.
 */
export function redactBotToken(text: string): string {
  return text.replace(/(\d{5,}):[\w-]{30,}/g, '$1:[REDACTED]');
}

/** An error's message and stack, token-redacted, for a log line. */
export function errorForLog(err: unknown): { message: string; stack?: string } {
  if (!(err instanceof Error)) return { message: redactBotToken(String(err)) };
  return {
    message: redactBotToken(err.message),
    stack: err.stack === undefined ? undefined : redactBotToken(err.stack),
  };
}

/**
 * Where polling stands; every transition is logged.
 *   idle      — constructed, never started
 *   starting  — launch() in flight (getMe → deleteWebhook); nothing polled yet
 *   polling   — Telegraf's getUpdates loop has started
 *   retrying  — after a transient failure; the next start() is scheduled
 *   failed    — after a permanent failure, or on an incompatible Telegraf;
 *               nothing will restart it
 *   stopped   — shut down
 */
export type PollingState =
  'idle' | 'starting' | 'polling' | 'retrying' | 'failed' | 'stopped';

/** The slice of Telegraf the supervisor drives. */
type PollableBot = Pick<Telegraf<Context>, 'launch' | 'stop' | 'botInfo'>;
type PollingLogger = Pick<Logger, 'log' | 'warn' | 'error'>;
/** Telegraf's own last launch step, which creates and runs the polling loop. */
type StartPolling = (...args: unknown[]) => Promise<void>;

/** Why a launch that shutdown overtook ends without ever polling. */
const SHUTDOWN_BEFORE_POLLING =
  'shutdown requested before long polling started';

export class BotPollingSupervisor {
  private state: PollingState = 'idle';
  /** Consecutive failed launches since polling last started. */
  private failures = 0;
  private retryTimer: NodeJS.Timeout | undefined;
  private stopRequested = false;
  /** Why this bot cannot be supervised, when it cannot (see
   *  observePollingStart): start() then never launches it. */
  private readonly incompatibility: string | undefined;

  constructor(
    private readonly bot: PollableBot,
    private readonly logger: PollingLogger,
    /** Delay before retry N (1-based). Production keeps the default; tests
     *  shorten it. */
    private readonly retryDelay: (
      failures: number,
      err: unknown,
    ) => number = pollingRetryDelayMs,
  ) {
    this.incompatibility = this.observePollingStart();
  }

  get status(): PollingState {
    return this.state;
  }

  /**
   * Launch polling unless it is already starting or running, shutdown has
   * begun, or this Telegraf cannot be supervised. Never throws, and leaves no
   * promise unhandled: every way the launch can end is routed to onEnded /
   * onFailed.
   */
  start(): void {
    if (
      this.stopRequested ||
      this.state === 'starting' ||
      this.state === 'polling'
    ) {
      return;
    }
    if (this.incompatibility !== undefined) {
      // Nothing a retry could change: reported once, and Telegraf is never
      // launched — a loop started without the guard could neither be seen to
      // start nor be kept from starting after shutdown.
      if (this.state !== 'failed') this.fail(this.incompatibility);
      return;
    }
    this.clearRetryTimer();
    this.state = 'starting';
    this.logger.log(
      this.failures === 0
        ? 'Bot starting (long polling)...'
        : `Bot starting (long polling)... retry ${this.failures}`,
    );
    this.bot
      .launch(() => this.onConnected())
      .then(
        () => this.onEnded(),
        (err: unknown) => this.onFailed(err),
      )
      // The handlers above only log and arm a timer. Should even that fail, it
      // is reported — going quiet is the failure this class exists to prevent —
      // but never as an unhandled rejection, which main.ts turns into an exit.
      .catch((err: unknown) => {
        try {
          const { message, stack } = errorForLog(err);
          this.logger.error(`Bot polling supervisor failed: ${message}`, stack);
        } catch {
          // Logging itself failed; nothing safer is left to do.
        }
      });
  }

  /**
   * Stop for good (application shutdown): no retry is pending afterwards and
   * none will be scheduled. Never throws.
   */
  stop(): void {
    this.stopRequested = true;
    this.clearRetryTimer();
    const running = this.state === 'starting' || this.state === 'polling';
    this.state = 'stopped';
    if (!running) return;
    try {
      this.bot.stop('shutdown');
    } catch {
      // Telegraf refuses ("Bot is not running!") while launch() is still
      // connecting: its polling loop does not exist yet. That launch is turned
      // away at its next step instead — onConnected or the wrapped
      // startPolling — so the loop never starts after shutdown.
    }
  }

  /**
   * Telegraf 4.16's launch() runs getMe → onLaunch → deleteWebhook → its own
   * (private) startPolling(), with no hook after onLaunch. Two things need that
   * last step, so it is wrapped on this bot instance:
   *   • it is when polling really begins. A successful getMe is not: the
   *     deleteWebhook after it can still fail, and resetting the backoff there
   *     would keep a failing connect retrying at the base delay forever;
   *   • it is the last point at which a shutdown can stop a launch already past
   *     getMe, since Telegraf's stop() refuses until the loop exists.
   * Without the step neither holds, so there is deliberately NO fallback: a
   * Telegraf that lacks it is incompatible and is never launched (see start()).
   * Returns that verdict, or undefined once the step is wrapped. Pinned to the
   * installed Telegraf by telegram.polling.spec.ts.
   */
  private observePollingStart(): string | undefined {
    const bot = this.bot as unknown as { startPolling?: StartPolling };
    const startPolling = bot.startPolling;
    if (typeof startPolling !== 'function') {
      return (
        'incompatible Telegraf: the installed telegraf has no startPolling() ' +
        'step, which this supervisor depends on (built and tested on telegraf ' +
        `${SUPPORTED_TELEGRAF_VERSION}, pinned in package.json). Not polling: ` +
        'reinstall the pinned version (npm ci, then `npm ls telegraf`) or adapt ' +
        'bot-polling.ts to the new release, then restart the process.'
      );
    }
    bot.startPolling = (...args: unknown[]) => {
      if (this.stopRequested) {
        return Promise.reject(new Error(SHUTDOWN_BEFORE_POLLING));
      }
      this.onPollingStarted();
      return startPolling.apply(this.bot, args) as Promise<void>;
    };
    return undefined;
  }

  private onConnected(): void {
    // launch() calls this once getMe has answered — BEFORE deleteWebhook and
    // the loop: the token works, but nothing is polled yet, so nothing is
    // reported active here. A shutdown that raced the connect is turned away
    // here, before even deleteWebhook. Throwing makes launch() reject
    // (→ onFailed).
    if (this.stopRequested) throw new Error(SHUTDOWN_BEFORE_POLLING);
  }

  private onPollingStarted(): void {
    this.state = 'polling';
    // The whole connect succeeded — getMe AND deleteWebhook — so the next
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
    switch (classifyPollingError(err)) {
      case 'unauthorized':
        this.fail(
          `Telegram rejected the bot token (${message}). Not retrying: fix ` +
            'TELEGRAM_BOT_TOKEN, then restart the process.',
        );
        return;
      case 'conflict':
        this.fail(
          `Telegram reports a conflict (${message}): another process is ` +
            'polling this bot token, or a webhook is set for it. Not retrying ' +
            'automatically: stop the other poller (every non-production ' +
            'instance must set TELEGRAM_POLLING_DISABLED=true) or delete the ' +
            'webhook, then restart this process.',
        );
        return;
      case 'rejected':
        this.fail(
          `Telegram refused the polling request (${message}). Not retrying: ` +
            'this needs a configuration or code fix.',
          stack,
        );
        return;
      case 'transient':
        this.retryLater(err);
    }
  }

  private fail(reason: string, stack?: string): void {
    this.state = 'failed';
    this.logger.error(`Bot polling STOPPED — ${reason}`, stack);
  }

  private retryLater(err: unknown): void {
    this.failures += 1;
    const delayMs = this.retryDelay(this.failures, err);
    this.state = 'retrying';
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
