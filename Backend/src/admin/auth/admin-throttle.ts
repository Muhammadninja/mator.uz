import { ExecutionContext } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import { ADMIN_JWT_AUDIENCE, ADMIN_JWT_ISSUER } from './admin-auth.config';

/**
 * Who a request's rate limit belongs to, for the global throttler.
 *
 * Every operator reaches the API through the panel's server, so they all share one
 * address. Counted per address, the limit is a budget split across the whole team:
 * a handful of open queue tabs polling every few seconds would answer 429 to
 * everyone. So a request carrying a valid admin token is counted against that
 * administrator instead, and one person's tabs only ever spend their own budget.
 *
 * The throttler runs before any auth guard, so the token is verified here. A claim
 * nobody checked cannot be trusted as a key: forged ids would each get a fresh
 * budget. Anything that does not verify is simply counted by address.
 */
export function verifiedAdminId(
  authorization: string | undefined,
  secret: string | undefined,
  nowMs: number = Date.now(),
): string | null {
  if (!secret || !authorization?.startsWith('Bearer ')) return null;
  const [header, payload, signature] = authorization.slice(7).split('.');
  if (!header || !payload || !signature) return null;

  try {
    const alg = (JSON.parse(base64UrlDecode(header)) as { alg?: unknown }).alg;
    if (alg !== 'HS256') return null;

    const expected = createHmac('sha256', secret)
      .update(`${header}.${payload}`)
      .digest();
    const given = Buffer.from(signature, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return null;
    }

    const claims = JSON.parse(base64UrlDecode(payload)) as {
      sub?: unknown;
      type?: unknown;
      iss?: unknown;
      aud?: unknown;
      exp?: unknown;
    };
    const live = typeof claims.exp === 'number' && claims.exp * 1000 > nowMs;
    return live &&
      claims.type === 'admin' &&
      claims.iss === ADMIN_JWT_ISSUER &&
      claims.aud === ADMIN_JWT_AUDIENCE &&
      typeof claims.sub === 'string'
      ? claims.sub
      : null;
  } catch {
    return null;
  }
}

function base64UrlDecode(part: string): string {
  return Buffer.from(part, 'base64url').toString('utf8');
}

function adminOf(req: Request): string | null {
  return verifiedAdminId(
    req.headers.authorization,
    process.env.ADMIN_JWT_SECRET?.trim(),
  );
}

/**
 * The global limits. `default` is the one @Throttle and @SkipThrottle refer to, so
 * the tighter limits on login, refresh and the like keep working as they were: those
 * requests carry no admin token and are still counted by address.
 *
 * `adminAddress` is the backstop per address for admin traffic only, set well above
 * what a team generates, so a stolen token cannot be used to hammer the API from one
 * place at the rate of many people. It leaves everyone else untouched, webhooks that
 * skip throttling included.
 *
 * Counters live in this process (the throttler's default storage), which holds while
 * the API runs as a single PM2 fork. A second instance would need a shared store, or
 * each would hand out its own budget.
 */
export const THROTTLERS = [
  {
    name: 'default',
    ttl: 60 * 1000,
    limit: 100,
    getTracker: (req: Record<string, unknown>) => {
      const admin = adminOf(req as unknown as Request);
      return admin ? `admin:${admin}` : ((req.ip as string) ?? 'unknown');
    },
  },
  {
    name: 'adminAddress',
    ttl: 60 * 1000,
    limit: 1000,
    skipIf: (context: ExecutionContext) =>
      adminOf(context.switchToHttp().getRequest<Request>()) === null,
    getTracker: (req: Record<string, unknown>) =>
      (req.ip as string) ?? 'unknown',
  },
];
