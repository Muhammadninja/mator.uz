/**
 * AI advisor configuration, read once per process from the environment.
 *
 * Nothing here is hardcoded to a production value: the model id, the token
 * ceiling, the message-size limit and the rate-limit window are all env-driven
 * so a deploy can retune them without a release. The defaults below are chosen
 * to be safe rather than generous — an unconfigured environment gets a small
 * budget, not an unbounded one.
 *
 * The API KEY is deliberately NOT part of this module: it is read directly by
 * {@link ClaudeService} and never copied into a config object that might be
 * logged, serialized into an error, or surfaced by a debug endpoint.
 */

/**
 * Default model. Pinned to a dated snapshot rather than a floating alias so a
 * provider-side alias move can never silently change what production runs; the
 * upgrade is then a visible config change.
 */
export const DEFAULT_AI_MODEL = 'claude-sonnet-4-5-20250929';

/** Default ceiling on a single reply. */
export const DEFAULT_AI_MAX_TOKENS = 1024;

/**
 * Longest user message accepted, in characters. Oversized messages are rejected
 * at the DTO boundary — before any provider call — so an abusive payload costs
 * a validation error rather than tokens.
 */
export const DEFAULT_AI_MAX_MESSAGE_CHARS = 4000;

/** Default per-user budget: messages allowed inside {@link DEFAULT_AI_RATE_WINDOW_SECONDS}. */
export const DEFAULT_AI_RATE_LIMIT = 20;

/** Default rate-limit window, in seconds. */
export const DEFAULT_AI_RATE_WINDOW_SECONDS = 300;

/**
 * How long to wait on the provider before giving up, in milliseconds. A hung
 * upstream must not pin a request (and an SSE connection) open indefinitely.
 */
export const DEFAULT_AI_TIMEOUT_MS = 60_000;

/** How many stored messages are replayed to the model as conversation history. */
export const DEFAULT_AI_HISTORY_LIMIT = 20;

export interface AiAdvisorConfig {
  model: string;
  maxTokens: number;
  maxMessageChars: number;
  rateLimit: number;
  rateWindowSeconds: number;
  timeoutMs: number;
  historyLimit: number;
}

/**
 * Parse a positive integer from the environment, falling back when the value is
 * absent, non-numeric, or non-positive. A malformed limit must never widen into
 * "no limit" — the fallback is always the configured default.
 */
function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function readAiAdvisorConfig(
  get: (key: string) => string | undefined,
): AiAdvisorConfig {
  return {
    model: get('AI_ADVISOR_MODEL')?.trim() || DEFAULT_AI_MODEL,
    maxTokens: positiveInt(get('AI_ADVISOR_MAX_TOKENS'), DEFAULT_AI_MAX_TOKENS),
    maxMessageChars: positiveInt(
      get('AI_ADVISOR_MAX_MESSAGE_CHARS'),
      DEFAULT_AI_MAX_MESSAGE_CHARS,
    ),
    rateLimit: positiveInt(get('AI_ADVISOR_RATE_LIMIT'), DEFAULT_AI_RATE_LIMIT),
    rateWindowSeconds: positiveInt(
      get('AI_ADVISOR_RATE_WINDOW_SECONDS'),
      DEFAULT_AI_RATE_WINDOW_SECONDS,
    ),
    timeoutMs: positiveInt(get('AI_ADVISOR_TIMEOUT_MS'), DEFAULT_AI_TIMEOUT_MS),
    historyLimit: positiveInt(
      get('AI_ADVISOR_HISTORY_LIMIT'),
      DEFAULT_AI_HISTORY_LIMIT,
    ),
  };
}
