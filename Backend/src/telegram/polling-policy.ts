import { TelegramError, type Context, type Telegraf } from 'telegraf';
import type { PollingErrorKind } from './polling-status';

/**
 * The seller bot's polling failure policy and log hygiene — pure functions,
 * applied by BotPollingSupervisor (bot-polling.ts, which re-exports them).
 */

/**
 * The Telegraf release the polling lifecycle is built and tested on. The
 * supervisor drives Telegraf's private startPolling step (see bot-polling.ts),
 * so package.json pins exactly this version; telegram.polling.spec.ts fails
 * should the pin, the lockfile, the installed package and this constant ever
 * disagree.
 */
export const SUPPORTED_TELEGRAF_VERSION = '4.16.3';

/** The slice of Telegraf the supervisor drives. `telegram` is only observed. */
export type PollableBot = Pick<Telegraf<Context>, 'stop' | 'botInfo'> & {
  telegram?: unknown;
};
/** The read-only Bot API calls made before polling: never deleteWebhook. */
export type ConnectApi = {
  getMe: () => Promise<NonNullable<Telegraf<Context>['botInfo']>>;
  getWebhookInfo: () => Promise<{ url?: string }>;
};
/** Telegraf's own step that creates and runs the polling loop. */
export type StartPolling = (...args: unknown[]) => Promise<void>;

/** Why a Telegraf without that step is never started. */
export const INCOMPATIBLE_TELEGRAF =
  'incompatible Telegraf: the installed telegraf has no startPolling() ' +
  'step, which this supervisor depends on (built and tested on telegraf ' +
  `${SUPPORTED_TELEGRAF_VERSION}, pinned in package.json). Not polling: ` +
  'reinstall the pinned version (npm ci, then `npm ls telegraf`) or adapt ' +
  'bot-polling.ts to the new release, then restart the process.';

/**
 * How a failed launch is handled:
 *   transient    — no answer from Telegram (DNS, refused/reset connection,
 *                  timeout) or a 429/5xx: retried with backoff;
 *   unauthorized — 401/404: the token is revoked or malformed;
 *   conflict     — 409: another process polls this token, or a webhook is set;
 *   rejected     — any other 4xx: Telegram refuses the request as made.
 * `transient` is retried; `conflict` waits for the conflict to end (see
 * polling-conflict.ts); the others are permanent.
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

/** The kind of a failed getUpdates, for the status report. */
export function pollingErrorKind(err: unknown): PollingErrorKind {
  if (!(err instanceof TelegramError)) return 'network';
  if (err.code === 429) return 'rate_limited';
  if (err.code >= 500) return 'server_error';
  if (err.code === 409) return 'conflict';
  if (err.code === 401 || err.code === 404) return 'unauthorized';
  return 'rejected';
}

/** The log line for a revoked or malformed token. */
export function unauthorizedMessage(message: string): string {
  return (
    `Telegram rejected the bot token (${message}). Not retrying: fix ` +
    'TELEGRAM_BOT_TOKEN, then restart the process.'
  );
}

/** Telegram#callApi, the one door every Bot API request goes through. */
type CallApi = (
  method: string,
  payload?: Record<string, unknown>,
  ...rest: unknown[]
) => Promise<unknown>;

/**
 * Report every answer to the polling loop's getUpdates — the status report's
 * proof that polling really works — by wrapping callApi on the bot's own
 * Telegram instance. Passive: it adds no request, and changes neither the call
 * nor its result. Telegraf's loop uses exactly this instance (each update's ctx
 * gets its own), and only the loop's long polls carry a `timeout`; the offset
 * sync at the loop's end does not, and is ignored. Anything without a callApi
 * (a test double) is simply not observed.
 */
export function observeGetUpdates(
  telegram: unknown,
  on: { answered: (updates: unknown) => void; failed: (err: unknown) => void },
): void {
  const target = telegram as { callApi?: CallApi } | undefined;
  const callApi = target?.callApi;
  if (!target || typeof callApi !== 'function') return;
  target.callApi = (method, payload, ...rest) => {
    const result: Promise<unknown> = callApi.apply(target, [
      method,
      payload,
      ...rest,
    ]) as Promise<unknown>;
    if (method !== 'getUpdates' || payload?.timeout === undefined)
      return result;
    return result.then(
      (updates) => {
        on.answered(updates);
        return updates;
      },
      (err: unknown) => {
        on.failed(err);
        throw err;
      },
    );
  };
}
