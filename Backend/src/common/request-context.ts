import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

/** Header carrying the correlation id, in and out. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Length of a generated id, in hex characters. Six is the same size as an alert
 * fingerprint (see alerting.types.ts) — short enough to quote in a chat message
 * or read off a screen, wide enough (16.7M values) that two requests in the same
 * investigation window colliding is not a practical concern.
 */
const REQUEST_ID_LENGTH = 6;

/** Cap on an inbound client-supplied id, so a hostile header can't bloat logs. */
const MAX_INBOUND_LENGTH = 64;

export interface RequestContext {
  /** Short, human-quotable correlation id, e.g. "3AA7FC". */
  requestId: string;
}

/**
 * Per-request state, propagated implicitly through the async call tree.
 *
 * ── Why AsyncLocalStorage rather than passing the id around ──
 * The id is needed at the very bottom of the stack (an audit write, a log line
 * in a service three calls deep) but is only known at the very top (HTTP). The
 * alternative is threading a `requestId` parameter through every service method
 * that might ever log — which changes dozens of signatures, is impossible to
 * enforce, and silently degrades the moment someone forgets. ALS carries it
 * invisibly for the lifetime of the request, including across `await`.
 *
 * Anything outside an HTTP request (queue workers, cron jobs, the Telegram bot)
 * simply has no context, and callers must handle `undefined` — see
 * {@link getRequestId}.
 */
export const requestContext = new AsyncLocalStorage<RequestContext>();

/** A fresh, uppercase hex correlation id. */
export function generateRequestId(): string {
  return randomBytes(Math.ceil(REQUEST_ID_LENGTH / 2))
    .toString('hex')
    .slice(0, REQUEST_ID_LENGTH)
    .toUpperCase();
}

/**
 * Normalize a client-supplied `X-Request-Id`.
 *
 * Honouring an inbound id lets a caller correlate across service boundaries,
 * but the value is UNTRUSTED: it lands in log lines and an audit column, so it
 * is length-capped and stripped of everything outside a conservative charset —
 * no newlines (log forging), no control characters.
 *
 * @returns the sanitized id, or null when unusable (caller should generate one).
 */
export function sanitizeRequestId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/[^A-Za-z0-9._-]/g, '');
  return cleaned ? cleaned.slice(0, MAX_INBOUND_LENGTH) : null;
}

/**
 * The current request's correlation id, or undefined outside an HTTP request.
 * Never throws — a missing context must not break the work being done.
 */
export function getRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

/** Run `fn` with a fresh request context bound to `requestId`. */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return requestContext.run({ requestId }, fn);
}
