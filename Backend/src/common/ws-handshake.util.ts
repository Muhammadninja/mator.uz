import { BlockList, isIP } from 'node:net';
import type { IncomingMessage } from 'http';
import { resolveTrustProxy } from './trust-proxy.util';

/**
 * The subprotocol a client offers to carry its access token on the WebSocket
 * handshake: `Sec-WebSocket-Protocol: mator.bearer, <jwt>`. Browsers and React
 * Native cannot set an Authorization header on a WebSocket, and a token in the
 * URL ends up in proxy access logs; a subprotocol works in both and is not
 * logged. The server selects {@link WS_BEARER_PROTOCOL} and never echoes the token.
 */
export const WS_BEARER_PROTOCOL = 'mator.bearer';

/** `handleProtocols` for `ws.Server`: select the marker, never the token. */
export function selectWsProtocol(protocols: Set<string>): string | false {
  return protocols.has(WS_BEARER_PROTOCOL) ? WS_BEARER_PROTOCOL : false;
}

/**
 * The access token presented on a WebSocket upgrade. `Authorization: Bearer`
 * wins, then the bearer subprotocol. The `token` query parameter is read only
 * when `allowQuery` is set: it exists for app builds released before the
 * subprotocol and is switched off once they are gone.
 */
export function extractWsToken(
  request: IncomingMessage,
  allowQuery: boolean,
): string | null {
  const header = request.headers['authorization'];
  if (header?.startsWith('Bearer ')) return header.slice(7).trim() || null;

  const offered = request.headers['sec-websocket-protocol'];
  if (typeof offered === 'string') {
    const parts = offered.split(',').map((p) => p.trim());
    const at = parts.indexOf(WS_BEARER_PROTOCOL);
    if (at !== -1 && parts[at + 1]) return parts[at + 1];
  }

  if (allowQuery) {
    const url = new URL(request.url ?? '', 'http://localhost');
    return url.searchParams.get('token') || null;
  }
  return null;
}

const NAMED_RANGES: Record<string, [string, number, 'ipv4' | 'ipv6'][]> = {
  loopback: [
    ['127.0.0.0', 8, 'ipv4'],
    ['::1', 128, 'ipv6'],
  ],
  linklocal: [
    ['169.254.0.0', 16, 'ipv4'],
    ['fe80::', 10, 'ipv6'],
  ],
  uniquelocal: [
    ['10.0.0.0', 8, 'ipv4'],
    ['172.16.0.0', 12, 'ipv4'],
    ['192.168.0.0', 16, 'ipv4'],
    ['fc00::', 7, 'ipv6'],
  ],
};

function family(ip: string): 'ipv4' | 'ipv6' {
  return isIP(ip) === 6 ? 'ipv6' : 'ipv4';
}

/** `::ffff:1.2.3.4` and `1.2.3.4` are the same client. */
function normalizeIp(raw: string | undefined): string {
  const ip = (raw ?? '').trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return mapped ? mapped[1] : ip;
}

/** The proxies whose X-Forwarded-For entry is believed (same rule as HTTP). */
export function trustedProxyList(raw: string | undefined): BlockList {
  const list = new BlockList();
  for (const entry of resolveTrustProxy(raw).split(',')) {
    const value = entry.trim();
    if (!value) continue;
    const named = NAMED_RANGES[value.toLowerCase()];
    if (named) {
      for (const [net, prefix, fam] of named) list.addSubnet(net, prefix, fam);
      continue;
    }
    const [address, prefix] = value.split('/');
    if (isIP(address) === 0) {
      throw new Error(
        `TRUST_PROXY entry "${value}" is not an address or range`,
      );
    }
    if (prefix === undefined) list.addAddress(address, family(address));
    else list.addSubnet(address, Number(prefix), family(address));
  }
  return list;
}

/**
 * The client address of a WebSocket upgrade, in a form the client cannot pick.
 *
 * The address that opened the socket cannot be forged. Only when it is a trusted
 * proxy is X-Forwarded-For read, and then from the right: each proxy appends the
 * address it saw, so the first entry that is not itself a trusted proxy is the
 * client. Entries to its left were supplied by the client and are ignored.
 */
export function wsClientIp(
  request: IncomingMessage,
  trusted: BlockList,
): string {
  const peer = normalizeIp(request.socket?.remoteAddress);
  if (!peer || isIP(peer) === 0) return peer || 'unknown';
  if (!trusted.check(peer, family(peer))) return peer;

  const header = request.headers['x-forwarded-for'];
  const chain = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map(normalizeIp)
    .filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i--) {
    const hop = chain[i];
    if (isIP(hop) === 0) return peer;
    if (!trusted.check(hop, family(hop))) return hop;
  }
  return peer;
}

/** Sliding-window handshake limiter keyed by client address. */
export class HandshakeLimiter {
  private readonly attempts = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Records this attempt; true when the address is over the limit. */
  hit(ip: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const recent = (this.attempts.get(ip) ?? []).filter((t) => t > cutoff);
    recent.push(now);
    this.attempts.set(ip, recent);
    return recent.length > this.limit;
  }

  /** Drop expired windows so the map cannot grow without bound. */
  prune(now = Date.now()): void {
    const cutoff = now - this.windowMs;
    for (const [ip, times] of this.attempts) {
      const live = times.filter((t) => t > cutoff);
      if (live.length === 0) this.attempts.delete(ip);
      else this.attempts.set(ip, live);
    }
  }
}
