import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { WebSocket } from 'ws';
import { WsAuthService } from '../../src/realtime/ws-auth.service';
import { RealtimeGateway } from '../../src/realtime/realtime.gateway';
import { TokenService } from '../../src/auth/tokens/token.service';
import { JwtKeyService } from '../../src/auth/tokens/jwt-key.service';
import { createPrismaMock, fakeConfig, fakeRedis, PrismaMock } from '../utils/harness';

function fakeSocket() {
  const handlers: Record<string, (...a: any[]) => void> = {};
  return {
    readyState: WebSocket.OPEN,
    on: jest.fn((ev: string, cb: (...a: any[]) => void) => {
      handlers[ev] = cb;
    }),
    send: jest.fn(),
    close: jest.fn(),
    terminate: jest.fn(),
    ping: jest.fn(),
    handlers,
  };
}

describe('Realtime smoke', () => {
  describe('WsAuthService (real RS256 token)', () => {
    let prisma: PrismaMock;
    let keys: JwtKeyService;
    let jwt: JwtService;
    let accessToken: string;
    let tokens: TokenService;
    let redis: ReturnType<typeof fakeRedis>;
    const make = (env: Record<string, string> = {}) =>
      new WsAuthService(jwt, keys, prisma, fakeConfig(env), tokens, redis);

    beforeEach(async () => {
      redis = fakeRedis();
      prisma = createPrismaMock();
      keys = new JwtKeyService(fakeConfig());
      jwt = new JwtService({});
      prisma.refreshToken.create.mockResolvedValue({ id: 'rt' });
      // Session versioning: the handshake re-reads the account's current version.
      prisma.appUser.findUnique.mockResolvedValue({ tokenVersion: 0 });
      tokens = new TokenService(prisma, jwt, keys, fakeConfig(), redis);
      accessToken = (
        await tokens.issueSession({
          id: 'usr_1',
          email: null,
          role: 'USER',
          tokenVersion: 0,
        })
      ).accessToken;
    });

    it('authenticates a valid token from the query string', async () => {
      const wsAuth = make();
      const { userId } = await wsAuth.authenticate({
        url: `/realtime?channel=garage:usr_1&token=${accessToken}`,
        headers: {},
      } as any);
      expect(userId).toBe('usr_1');
    });

    it('refuses the query-string token once REALTIME_QUERY_TOKEN_ENABLED=false', async () => {
      const wsAuth = make({ REALTIME_QUERY_TOKEN_ENABLED: 'false' });
      await expect(
        wsAuth.authenticate({
          url: `/realtime?channel=garage:usr_1&token=${accessToken}`,
          headers: {},
        } as any),
      ).rejects.toThrow('Missing token');
    });

    it('authenticates from the bearer subprotocol, keeping the token out of the URL', async () => {
      const wsAuth = make({ REALTIME_QUERY_TOKEN_ENABLED: 'false' });
      const session = await wsAuth.authenticate({
        url: '/realtime?channel=garage:usr_1',
        headers: { 'sec-websocket-protocol': `mator.bearer, ${accessToken}` },
      } as any);
      expect(session.userId).toBe('usr_1');
      expect(session.jti).toEqual(expect.any(String));
      expect(session.exp).toEqual(expect.any(Number));
    });

    it('rejects a logged-out token: its jti is blacklisted', async () => {
      const wsAuth = make();
      const { jti, exp } = jwt.decode(accessToken) as { jti: string; exp: number };
      await tokens.blacklistAccessToken(jti, exp);
      await expect(
        wsAuth.authenticate({
          url: '/realtime?channel=garage:usr_1',
          headers: { authorization: `Bearer ${accessToken}` },
        } as any),
      ).rejects.toThrow('Token revoked');
    });

    it('does not read an unreachable blacklist as "not revoked"', async () => {
      const wsAuth = make();
      redis.exists.mockRejectedValue(new Error('Redis unavailable'));
      await expect(
        wsAuth.authenticate({
          url: '/realtime?channel=garage:usr_1',
          headers: { authorization: `Bearer ${accessToken}` },
        } as any),
      ).rejects.toThrow('Redis unavailable');
    });

    it('rejects a deleted account', async () => {
      const wsAuth = make();
      prisma.appUser.findUnique.mockResolvedValue({
        tokenVersion: 0,
        deletedAt: new Date(),
      });
      await expect(
        wsAuth.authenticate({
          url: '/realtime?channel=garage:usr_1',
          headers: { authorization: `Bearer ${accessToken}` },
        } as any),
      ).rejects.toThrow('Token revoked');
    });

    it('rejects a missing/invalid token', async () => {
      const wsAuth = make();
      await expect(
        wsAuth.authenticate({
          url: '/realtime?channel=garage:usr_1',
          headers: {},
        } as any),
      ).rejects.toThrow();
      await expect(
        wsAuth.authenticate({
          url: '/realtime?channel=garage:usr_1&token=garbage',
          headers: {},
        } as any),
      ).rejects.toThrow();
    });

    it('authenticates from the Authorization header', async () => {
      const wsAuth = make();
      const { userId } = await wsAuth.authenticate({
        url: '/realtime?channel=garage:usr_1',
        headers: { authorization: `Bearer ${accessToken}` },
      } as any);
      expect(userId).toBe('usr_1');
    });

    it('prefers the Authorization header when both header and query token are present', async () => {
      const wsAuth = make();
      // Garbage query token would fail; the valid header must win.
      const { userId } = await wsAuth.authenticate({
        url: '/realtime?channel=garage:usr_1&token=garbage',
        headers: { authorization: `Bearer ${accessToken}` },
      } as any);
      expect(userId).toBe('usr_1');
    });

    it('rejects a token whose session version was revoked', async () => {
      const wsAuth = make();
      // logout-all bumped the account to version 1; the token still carries 0.
      prisma.appUser.findUnique.mockResolvedValue({ tokenVersion: 1 });
      await expect(
        wsAuth.authenticate({
          url: '/realtime?channel=garage:usr_1',
          headers: { authorization: `Bearer ${accessToken}` },
        } as any),
      ).rejects.toThrow('Token revoked');
    });
  });

  describe('RealtimeGateway', () => {
    let gateway: RealtimeGateway;
    let wsAuth: { authenticate: jest.Mock; stillValid: jest.Mock };
    let tokens: { onSessionsRevoked: jest.Mock; onAccessTokenRevoked: jest.Mock };
    let revokeToken: ((jti: string) => void) | undefined;
    const session = (userId: string, over: Record<string, unknown> = {}) => ({
      userId,
      tokenVersion: 0,
      jti: `jti-${userId}`,
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...over,
    });
    /** Whatever the gateway subscribed to TokenService with, if anything. */
    let revoke: ((userId: string) => void) | undefined;

    beforeEach(() => {
      wsAuth = { authenticate: jest.fn(), stillValid: jest.fn() };
      revoke = undefined;
      revokeToken = undefined;
      tokens = {
        onAccessTokenRevoked: jest.fn((listener: (jti: string) => void) => {
          revokeToken = listener;
        }),
        onSessionsRevoked: jest.fn((listener: (userId: string) => void) => {
          revoke = listener;
        }),
      };
      gateway = new RealtimeGateway(wsAuth as any, tokens as any);
    });

    it('accepts an authorized garage channel and pushes events to it', async () => {
      wsAuth.authenticate.mockResolvedValue(session('usr_1'));
      const sock = fakeSocket();
      await gateway.handleConnection(
        sock as any,
        { url: '/realtime?channel=garage:usr_1', headers: {} } as any,
      );

      const connected = JSON.parse(sock.send.mock.calls[0][0]);
      expect(connected.type).toBe('connected');

      gateway.emitGarageEvent('usr_1', 'vehicle.updated', { id: 'veh_1' });
      const frame = JSON.parse(sock.send.mock.calls[1][0]);
      expect(frame).toMatchObject({
        type: 'vehicle.updated',
        data: { id: 'veh_1' },
      });
      expect(frame.ts).toEqual(expect.any(Number));
    });

    it('closes a channel that does not match the authenticated user (4403)', async () => {
      wsAuth.authenticate.mockResolvedValue(session('usr_1'));
      const sock = fakeSocket();
      await gateway.handleConnection(
        sock as any,
        { url: '/realtime?channel=garage:someone_else', headers: {} } as any,
      );
      expect(sock.close).toHaveBeenCalledWith(4403, 'forbidden_channel');
    });

    it('closes an unauthenticated connection (4401)', async () => {
      wsAuth.authenticate.mockRejectedValue(
        new UnauthorizedException('no token'),
      );
      const sock = fakeSocket();
      await gateway.handleConnection(
        sock as any,
        { url: '/realtime?channel=garage:usr_1', headers: {} } as any,
      );
      expect(sock.close).toHaveBeenCalledWith(4401, 'unauthorized');
    });

    it('closes as "try again" (1013), not as unauthorized, when the check cannot be made', async () => {
      wsAuth.authenticate.mockRejectedValue(new Error('Redis unavailable'));
      const sock = fakeSocket();
      await gateway.handleConnection(
        sock as any,
        { url: '/realtime?channel=garage:usr_1', headers: {} } as any,
      );
      expect(sock.close).toHaveBeenCalledWith(1013, 'unavailable');
      gateway.emitGarageEvent('usr_1', 'vehicle.updated', {});
      expect(sock.send).toHaveBeenCalledTimes(1); // only the error frame
    });

    it('logout closes the socket opened with that access token, and no other', async () => {
      gateway.onModuleInit();
      const mine = fakeSocket();
      const otherDevice = fakeSocket();
      wsAuth.authenticate.mockResolvedValueOnce(session('usr_1', { jti: 'a' }));
      await gateway.handleConnection(
        mine as any,
        { url: '/realtime?channel=garage:usr_1', headers: {} } as any,
      );
      wsAuth.authenticate.mockResolvedValueOnce(session('usr_1', { jti: 'b' }));
      await gateway.handleConnection(
        otherDevice as any,
        { url: '/realtime?channel=garage:usr_1', headers: {} } as any,
      );

      revokeToken!('a');

      expect(mine.close).toHaveBeenCalledWith(4401, 'session_revoked');
      expect(otherDevice.close).not.toHaveBeenCalled();
    });

    it('closes a socket whose access token has expired', async () => {
      jest.useFakeTimers();
      try {
        gateway.afterInit({ on: jest.fn() } as any);
        wsAuth.authenticate.mockResolvedValue(
          session('usr_1', { exp: Math.floor(Date.now() / 1000) + 20 }),
        );
        const sock = fakeSocket();
        await gateway.handleConnection(
          sock as any,
          { url: '/realtime?channel=garage:usr_1', headers: {} } as any,
        );
        jest.advanceTimersByTime(30_000);
        expect(sock.close).toHaveBeenCalledWith(4401, 'token_expired');
      } finally {
        jest.useRealTimers();
      }
    });

    it('revalidation closes revoked sockets in one batch and keeps the rest', async () => {
      const revoked = fakeSocket();
      const kept = fakeSocket();
      wsAuth.authenticate.mockResolvedValueOnce(session('usr_1'));
      await gateway.handleConnection(
        revoked as any,
        { url: '/realtime?channel=garage:usr_1', headers: {} } as any,
      );
      wsAuth.authenticate.mockResolvedValueOnce(session('usr_2'));
      await gateway.handleConnection(
        kept as any,
        { url: '/realtime?channel=garage:usr_2', headers: {} } as any,
      );
      wsAuth.stillValid.mockResolvedValue([false, true]);

      await gateway.revalidate();

      expect(wsAuth.stillValid).toHaveBeenCalledTimes(1);
      expect(revoked.close).toHaveBeenCalledWith(4401, 'session_revoked');
      expect(kept.close).not.toHaveBeenCalled();
    });

    it('revalidation that cannot reach its stores closes sockets as "try again"', async () => {
      const sock = fakeSocket();
      wsAuth.authenticate.mockResolvedValue(session('usr_1'));
      await gateway.handleConnection(
        sock as any,
        { url: '/realtime?channel=garage:usr_1', headers: {} } as any,
      );
      wsAuth.stillValid.mockRejectedValue(new Error('Redis unavailable'));
      await gateway.revalidate();
      expect(sock.close).toHaveBeenCalledWith(1013, 'unavailable');
    });

    // ── Revocation ────────────────────────────────────────────────────────────
    // The token is only checked at handshake, so without this an already-open
    // socket would keep streaming after logout-all / a phone change.
    it('subscribes to session revocations at module init', () => {
      gateway.onModuleInit();
      expect(tokens.onSessionsRevoked).toHaveBeenCalledTimes(1);
      expect(revoke).toEqual(expect.any(Function));
    });

    it('a revocation closes the user\'s live sockets (4401 session_revoked)', async () => {
      gateway.onModuleInit();
      wsAuth.authenticate.mockResolvedValue(session('usr_1'));
      const first = fakeSocket();
      const second = fakeSocket();
      for (const sock of [first, second]) {
        await gateway.handleConnection(
          sock as any,
          {
            url: '/realtime?channel=garage:usr_1',
            headers: {},
            socket: { remoteAddress: '10.0.0.1' },
          } as any,
        );
      }

      revoke!('usr_1');

      for (const sock of [first, second]) {
        expect(sock.close).toHaveBeenCalledWith(4401, 'session_revoked');
      }
      // Bookkeeping is dropped immediately, so nothing is pushed afterwards.
      first.send.mockClear();
      gateway.emitGarageEvent('usr_1', 'vehicle.updated', { id: 'veh_1' });
      expect(first.send).not.toHaveBeenCalled();
    });

    it('a revocation leaves other users connected', async () => {
      gateway.onModuleInit();
      wsAuth.authenticate.mockResolvedValue(session('usr_2'));
      const other = fakeSocket();
      await gateway.handleConnection(
        other as any,
        { url: '/realtime?channel=garage:usr_2', headers: {} } as any,
      );

      expect(gateway.disconnectUser('usr_1')).toBe(0); // nobody connected
      revoke!('usr_1');
      expect(other.close).not.toHaveBeenCalled();
    });

    it('answers an app-level ping with a pong', async () => {
      wsAuth.authenticate.mockResolvedValue(session('usr_1'));
      const sock = fakeSocket();
      await gateway.handleConnection(
        sock as any,
        { url: '/realtime?channel=garage:usr_1', headers: {} } as any,
      );
      sock.send.mockClear();

      sock.handlers['message'](Buffer.from(JSON.stringify({ type: 'ping' })));
      expect(JSON.parse(sock.send.mock.calls[0][0]).type).toBe('pong');
    });

    it('heartbeat pings live sockets and terminates unresponsive ones', async () => {
      jest.useFakeTimers();
      try {
        wsAuth.authenticate.mockResolvedValue(session('usr_1'));
        gateway.afterInit({ on: jest.fn() } as any);
        const sock = fakeSocket();
        await gateway.handleConnection(
          sock as any,
          { url: '/realtime?channel=garage:usr_1', headers: {} } as any,
        );

        jest.advanceTimersByTime(30_000); // first sweep: ping, mark not-alive
        expect(sock.ping).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(30_000); // second sweep: no pong came back -> terminate
        expect(sock.terminate).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it('rejects connections beyond the per-user limit (4408) without touching existing ones', async () => {
      wsAuth.authenticate.mockResolvedValue(session('usr_1'));
      const url = '/realtime?channel=garage:usr_1';
      // Annotated: an empty literal infers `never[]`, which rejects every push.
      const accepted: ReturnType<typeof fakeSocket>[] = [];
      // Open up to the cap; every distinct IP so the handshake rate limit
      // (per-IP) never trips and we isolate the per-user cap.
      for (let i = 0; i < 15; i++) {
        const sock = fakeSocket();
        await gateway.handleConnection(
          sock as any,
          { url, headers: {}, socket: { remoteAddress: `10.0.0.${i}` } } as any,
        );
        accepted.push(sock);
      }
      for (const sock of accepted) expect(sock.close).not.toHaveBeenCalled();

      const overflow = fakeSocket();
      await gateway.handleConnection(
        overflow as any,
        { url, headers: {}, socket: { remoteAddress: '10.0.0.99' } } as any,
      );
      expect(overflow.close).toHaveBeenCalledWith(4408, 'too_many_connections');
      // Existing sockets remain open.
      for (const sock of accepted)
        expect(sock.terminate).not.toHaveBeenCalled();
    });

    it('rate-limits repeated handshakes from the same IP (4429), before authenticating', async () => {
      wsAuth.authenticate.mockResolvedValue(session('usr_1'));
      // Nginx on this machine vouches for the address it appended.
      const req = {
        url: '/realtime?channel=garage:usr_1',
        headers: { 'x-forwarded-for': '203.0.113.7' },
        socket: { remoteAddress: '127.0.0.1' },
      };
      // 30 attempts allowed per minute; the 31st from the same IP is limited.
      for (let i = 0; i < 30; i++) {
        await gateway.handleConnection(fakeSocket() as any, req as any);
      }
      const blocked = fakeSocket();
      await gateway.handleConnection(blocked as any, req as any);
      expect(blocked.close).toHaveBeenCalledWith(4429, 'rate_limited');
    });

    it('a spoofed X-Forwarded-For does not buy a fresh handshake allowance', async () => {
      wsAuth.authenticate.mockResolvedValue(session('usr_1'));
      // A direct client (not the proxy) inventing a new address per attempt,
      // and one behind the proxy prepending invented entries.
      const direct = (i: number) => ({
        url: '/realtime?channel=garage:usr_1',
        headers: { 'x-forwarded-for': `198.51.100.${i}` },
        socket: { remoteAddress: '203.0.113.50' },
      });
      const proxied = (i: number) => ({
        url: '/realtime?channel=garage:usr_1',
        headers: { 'x-forwarded-for': `198.51.100.${i}, 203.0.113.60` },
        socket: { remoteAddress: '::ffff:127.0.0.1' },
      });
      for (const make of [direct, proxied]) {
        for (let i = 0; i < 30; i++) {
          await gateway.handleConnection(fakeSocket() as any, make(i) as any);
        }
        const blocked = fakeSocket();
        await gateway.handleConnection(blocked as any, make(99) as any);
        expect(blocked.close).toHaveBeenCalledWith(4429, 'rate_limited');
      }
    });
  });
});
