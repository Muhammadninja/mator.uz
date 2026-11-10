import { createHash, timingSafeEqual } from 'node:crypto';
import type { BlockList } from 'node:net';
import { isIP } from 'node:net';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import { trustedProxyList, wsClientIp } from '../common/ws-handshake.util';

/** Shorter than this, a scrape token is treated as not configured. */
const MIN_TOKEN_LENGTH = 24;

export interface MetricsAccess {
  /** Bearer token Prometheus presents, or null when none is configured. */
  token: string | null;
  /** Client addresses allowed without a token. */
  allowed: BlockList;
  /** Proxies whose X-Forwarded-For entry is believed (the HTTP rule). */
  trustedProxies: BlockList;
}

/**
 * Who may scrape, from the environment:
 *
 *   • METRICS_TOKEN: a bearer token (at least 24 characters). Prometheus sends
 *     it with `authorization: { credentials: … }` in its scrape config.
 *   • METRICS_ALLOWED_IPS: addresses or CIDR ranges allowed without a token,
 *     in TRUST_PROXY syntax. Default `loopback`: a Prometheus on this machine
 *     scraping the app port directly keeps working with no configuration.
 */
export function resolveMetricsAccess(env: NodeJS.ProcessEnv): MetricsAccess {
  const token = env.METRICS_TOKEN?.trim() ?? '';
  const allowed = env.METRICS_ALLOWED_IPS?.trim();
  return {
    token: token.length >= MIN_TOKEN_LENGTH ? token : null,
    // An entry that is not an address fails the boot (trustedProxyList throws),
    // the same as TRUST_PROXY: a typo must not quietly open or close the route.
    allowed: trustedProxyList(allowed || 'loopback'),
    trustedProxies: trustedProxyList(env.TRUST_PROXY),
  };
}

function sameSecret(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Access control for the Prometheus endpoint (LOW-PLT-015).
 *
 * The scrape carries business counters (SMS spend, routing quota, order and
 * queue volumes), so it is not public. A request is served when it presents the
 * configured bearer token, or when it comes from an allowed address.
 *
 * "Comes from" is the address the client cannot choose: the socket's own
 * address, or, only when that socket belongs to a trusted proxy, the entry that
 * proxy appended to X-Forwarded-For. So a request Nginx forwards from the
 * internet is judged by the internet address, not by Nginx's loopback one, and a
 * client that invents an `X-Forwarded-For: 127.0.0.1` gains nothing.
 *
 * Refusals are 403 with no detail, and the reason is not logged per request: a
 * scanner must not be able to fill the log.
 */
@Injectable()
export class MetricsAccessGuard implements CanActivate {
  private readonly logger = new Logger(MetricsAccessGuard.name);
  private readonly access = resolveMetricsAccess(process.env);

  constructor() {
    this.logger.log(
      `Metrics access: ${this.access.token ? 'bearer token or ' : ''}allowed addresses` +
        ` (${process.env.METRICS_ALLOWED_IPS?.trim() || 'loopback'})`,
    );
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (isMetricsRequestAllowed(req, this.access)) return true;
    throw new ForbiddenException();
  }
}

export function isMetricsRequestAllowed(
  req: Pick<Request, 'headers' | 'socket' | 'url'>,
  access: MetricsAccess,
): boolean {
  const header = req.headers.authorization;
  if (
    access.token &&
    typeof header === 'string' &&
    header.startsWith('Bearer ')
  ) {
    if (sameSecret(header.slice(7).trim(), access.token)) return true;
  }
  const client = wsClientIp(req as never, access.trustedProxies);
  const kind = isIP(client);
  if (kind === 0) return false;
  return access.allowed.check(client, kind === 6 ? 'ipv6' : 'ipv4');
}
