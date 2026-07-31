import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Blueprint access control.
 *
 * The DB-telemetry feed leaks the schema shape and live query patterns, so it
 * is an operator-only tool. Two gates:
 *
 *  1. **Server-to-server token** (`BLUEPRINT_TOKEN`) — the admin's server-side
 *     proxy sends it as `x-blueprint-token` to read the graph and MINT a
 *     ticket. It never reaches the browser.
 *
 *  2. **Short-lived WS ticket** — browsers cannot set headers on a WebSocket,
 *     so instead of putting the long-lived token in the URL we mint a signed,
 *     ~60s HMAC ticket. The gateway verifies it statelessly on handshake. A
 *     leaked ticket is useless in a minute.
 *
 * The whole feature is additionally disabled in production unless
 * `BLUEPRINT_ENABLED=true` (see app.module wiring), mirroring the Swagger gate.
 */

/** True when the blueprint module should be mounted at all. */
export function isBlueprintEnabled(): boolean {
  const flag = process.env.BLUEPRINT_ENABLED;
  if (flag != null) return flag === 'true';
  // Default: on outside production, off in production (opt-in).
  return process.env.NODE_ENV !== 'production';
}

/** The shared operator token, or '' if unconfigured (which denies everything). */
export function blueprintToken(): string {
  return (process.env.BLUEPRINT_TOKEN ?? '').trim();
}

function ticketSecret(): string {
  // Dedicated secret preferred; fall back to the operator token so a single
  // env var is enough to get running in dev.
  return (process.env.BLUEPRINT_TICKET_SECRET ?? blueprintToken()).trim();
}

/** Constant-time string compare that never throws on length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Validate the server-to-server operator token. Empty config ⇒ deny. */
export function verifyOperatorToken(presented: string | undefined): boolean {
  const expected = blueprintToken();
  if (!expected) return false; // fail closed when unconfigured
  return typeof presented === 'string' && safeEqual(presented, expected);
}

const TICKET_TTL_MS = 60_000;

/** Mint a `<expMs>.<hmac>` ticket valid for ~60s. */
export function mintTicket(now = Date.now()): { ticket: string; expiresAt: number } {
  const secret = ticketSecret();
  const exp = now + TICKET_TTL_MS;
  const sig = createHmac('sha256', secret).update(String(exp)).digest('hex');
  return { ticket: `${exp}.${sig}`, expiresAt: exp };
}

/** Verify a WS ticket: well-formed, signature valid, not expired. */
export function verifyTicket(ticket: string | null, now = Date.now()): boolean {
  const secret = ticketSecret();
  if (!secret || !ticket) return false;
  const dot = ticket.indexOf('.');
  if (dot <= 0) return false;
  const expPart = ticket.slice(0, dot);
  const sig = ticket.slice(dot + 1);
  const exp = Number(expPart);
  if (!Number.isFinite(exp) || exp < now) return false; // expired / malformed
  const expected = createHmac('sha256', secret).update(expPart).digest('hex');
  return safeEqual(sig, expected);
}
