import type { Telegram } from 'telegraf';

/**
 * How long one Bot API call from the alerts worker may take before it is given up on.
 *
 * Telegraf's own limit is 500 s per call (the node-fetch `timeout` in its ApiClient). The
 * alerts worker runs one job at a time, so that an alert's ACTIVE can never overtake its
 * RESOLVED, which means a single hung call would hold every alert and order notice behind
 * it for more than eight minutes per attempt. Telegram answers a sendMessage in well under
 * a second; fifteen seconds is generous, and a call given up on is retried by BullMQ like
 * any other failure.
 */
export const TELEGRAM_SEND_TIMEOUT_MS = 15_000;

/** The signal type Telegraf's callApi takes (its typings name abort-controller's). */
type CallApiSignal = NonNullable<Parameters<Telegram['callApi']>[2]>['signal'];

/**
 * Send one HTML message, bounded by `timeoutMs`. Throws on any failure (a Telegram error,
 * a network error, the timeout) so the BullMQ job around it retries.
 */
export async function sendTelegramHtml(
  telegram: Telegram,
  chatId: string,
  html: string,
  timeoutMs: number = TELEGRAM_SEND_TIMEOUT_MS,
): Promise<void> {
  await telegram.callApi(
    'sendMessage',
    {
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    },
    { signal: AbortSignal.timeout(timeoutMs) as unknown as CallApiSignal },
  );
}

/**
 * Whether a failed send can never succeed by being repeated: Telegram refused the
 * request itself (a 4xx such as "chat not found", "bot was blocked by the user", a
 * revoked token). 429 is the exception: it asks to come back later. Network errors and
 * Telegram's own 5xx are temporary.
 */
export function isPermanentTelegramFailure(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' && code >= 400 && code < 500 && code !== 429;
}
