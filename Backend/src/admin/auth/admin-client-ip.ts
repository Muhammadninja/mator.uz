import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request } from 'express';

export const PANEL_CLIENT_IP_HEADER = 'x-mator-panel-client-ip';
export const PANEL_TIMESTAMP_HEADER = 'x-mator-panel-timestamp';
export const PANEL_SIGNATURE_HEADER = 'x-mator-panel-signature';

const MAX_CLOCK_SKEW_MS = 60_000;
const MIN_SECRET_LENGTH = 32;

function panelSecret(): string | undefined {
  const secret = process.env.ADMIN_PROXY_SECRET?.trim();
  return secret && secret.length >= MIN_SECRET_LENGTH ? secret : undefined;
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

export function panelSignature(
  secret: string,
  timestamp: string,
  ip: string,
  method: string,
  path: string,
): Buffer {
  return createHmac('sha256', secret)
    .update(`${timestamp}\n${ip}\n${method.toUpperCase()}\n${path}`)
    .digest();
}

/**
 * The operator's address as vouched for by the admin panel's server.
 *
 * The panel calls this API server-to-server, so every operator arrives from the
 * panel's one address. It reports who it is acting for in a header signed with
 * ADMIN_PROXY_SECRET, a value only the two servers hold and browsers never see. An
 * unsigned, stale or wrongly signed value is ignored, so a client cannot choose it.
 */
export function verifiedPanelClientIp(
  req: Request,
  secret: string | undefined = panelSecret(),
  nowMs: number = Date.now(),
): string | null {
  if (!secret) return null;
  const ip = header(req, PANEL_CLIENT_IP_HEADER);
  const timestamp = header(req, PANEL_TIMESTAMP_HEADER);
  const signature = header(req, PANEL_SIGNATURE_HEADER);
  if (!ip || !timestamp || !signature || isIP(ip) === 0) return null;
  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(nowMs - sentAt) > MAX_CLOCK_SKEW_MS) {
    return null;
  }
  const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
  const expected = panelSignature(secret, timestamp, ip, req.method, path);
  const given = Buffer.from(signature, 'base64url');
  return given.length === expected.length && timingSafeEqual(given, expected)
    ? ip
    : null;
}

export interface AdminClientAddress {
  ip: string;
  /**
   * Whether this address identifies one client. False when the panel's secret is not
   * deployed: every operator then shares the panel's address, and limits keyed on it
   * would let one person's mistakes lock out the whole team.
   */
  distinct: boolean;
  /** The panel's signature, when one was accepted; a signature counts once. */
  proof?: string;
}

export function adminClientAddress(req: Request): AdminClientAddress {
  const verified = verifiedPanelClientIp(req);
  return {
    ip: verified ?? req.ip ?? 'unknown',
    distinct: verified !== null || panelSecret() !== undefined,
    ...(verified !== null ? { proof: header(req, PANEL_SIGNATURE_HEADER) } : {}),
  };
}
