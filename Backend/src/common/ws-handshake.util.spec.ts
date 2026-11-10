import type { IncomingMessage } from 'http';
import {
  HandshakeLimiter,
  extractWsToken,
  selectWsProtocol,
  trustedProxyList,
  wsClientIp,
} from './ws-handshake.util';

const req = (
  peer: string | undefined,
  xff?: string,
  extra: Record<string, string> = {},
) =>
  ({
    url: '/realtime',
    headers: { ...(xff ? { 'x-forwarded-for': xff } : {}), ...extra },
    socket: { remoteAddress: peer },
  }) as unknown as IncomingMessage;

describe('wsClientIp', () => {
  const loopback = trustedProxyList(undefined);

  it('uses the socket address of a direct client and ignores its X-Forwarded-For', () => {
    expect(wsClientIp(req('203.0.113.5', '1.1.1.1'), loopback)).toBe(
      '203.0.113.5',
    );
  });

  it('behind the local proxy, takes the entry the proxy appended, not the first', () => {
    expect(
      wsClientIp(req('127.0.0.1', '1.1.1.1, 9.9.9.9, 203.0.113.5'), loopback),
    ).toBe('203.0.113.5');
    expect(wsClientIp(req('::ffff:127.0.0.1', '203.0.113.5'), loopback)).toBe(
      '203.0.113.5',
    );
    expect(wsClientIp(req('::1', '203.0.113.5'), loopback)).toBe('203.0.113.5');
  });

  it('skips further trusted proxies named in TRUST_PROXY', () => {
    const trusted = trustedProxyList('loopback, 10.0.0.0/8');
    expect(
      wsClientIp(req('10.1.2.3', '6.6.6.6, 203.0.113.5, 10.9.9.9'), trusted),
    ).toBe('203.0.113.5');
  });

  it('falls back to the proxy address when the header is absent or malformed', () => {
    expect(wsClientIp(req('127.0.0.1'), loopback)).toBe('127.0.0.1');
    expect(wsClientIp(req('127.0.0.1', 'not-an-ip'), loopback)).toBe(
      '127.0.0.1',
    );
    expect(wsClientIp(req(undefined, '1.1.1.1'), loopback)).toBe('unknown');
  });

  it('refuses a blanket trust setting, as the HTTP side does', () => {
    expect(() => trustedProxyList('true')).toThrow();
    expect(() => trustedProxyList('1')).toThrow();
    expect(() => trustedProxyList('nginx')).toThrow();
  });
});

describe('extractWsToken', () => {
  it('reads the Authorization header first, then the bearer subprotocol', () => {
    expect(
      extractWsToken(
        req('1.1.1.1', undefined, {
          authorization: 'Bearer aaa',
          'sec-websocket-protocol': 'mator.bearer, bbb',
        }),
        false,
      ),
    ).toBe('aaa');
    expect(
      extractWsToken(
        req('1.1.1.1', undefined, {
          'sec-websocket-protocol': 'mator.bearer, bbb',
        }),
        false,
      ),
    ).toBe('bbb');
  });

  it('reads ?token= only when explicitly allowed', () => {
    const request = { url: '/realtime?token=ccc', headers: {} } as never;
    expect(extractWsToken(request, true)).toBe('ccc');
    expect(extractWsToken(request, false)).toBeNull();
  });

  it('selects the marker protocol and never echoes the token', () => {
    expect(selectWsProtocol(new Set(['mator.bearer', 'eyJ.token']))).toBe(
      'mator.bearer',
    );
    expect(selectWsProtocol(new Set(['something-else']))).toBe(false);
  });
});

describe('HandshakeLimiter', () => {
  it('limits per address within the window and forgets afterwards', () => {
    const limiter = new HandshakeLimiter(2, 1000);
    expect(limiter.hit('a', 0)).toBe(false);
    expect(limiter.hit('a', 1)).toBe(false);
    expect(limiter.hit('a', 2)).toBe(true);
    expect(limiter.hit('b', 2)).toBe(false);
    expect(limiter.hit('a', 2000)).toBe(false);
  });
});
