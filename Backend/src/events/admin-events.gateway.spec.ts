// LOW-PLT-009, admin half: an open /admin-events socket must not outlive the
// credentials that opened it, and the handshake must not read a client's own
// word for its address or accept a token in the URL.

import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AdminRole } from '@prisma/client';
import { WebSocket } from 'ws';
import {
  ADMIN_JWT_AUDIENCE,
  ADMIN_JWT_ISSUER,
} from '../admin/auth/admin-auth.config';
import type { AdminRevocation } from '../admin/auth/admin-token.service';
import { AdminEventsGateway } from './admin-events.gateway';
import { AdminWsAuthService } from './admin-ws-auth.service';

const SECRET = 'test-admin-secret-at-least-32-characters-long';

function fakeSocket() {
  return {
    readyState: WebSocket.OPEN,
    on: jest.fn(),
    send: jest.fn(),
    close: jest.fn(),
    terminate: jest.fn(),
    ping: jest.fn(),
  };
}

const session = (adminId: string, over: Record<string, unknown> = {}) => ({
  adminId,
  role: AdminRole.OPERATOR,
  tokenVersion: 1,
  jti: `jti-${adminId}`,
  sid: `sid-${adminId}`,
  exp: Math.floor(Date.now() / 1000) + 900,
  ...over,
});

describe('AdminEventsGateway', () => {
  let auth: { authenticate: jest.Mock; stillValid: jest.Mock };
  let revoke: (r: AdminRevocation) => void;
  let gateway: AdminEventsGateway;
  const req = { url: '/admin-events', headers: {} } as never;

  async function connect(s: ReturnType<typeof session>) {
    auth.authenticate.mockResolvedValueOnce(s);
    const sock = fakeSocket();
    await gateway.handleConnection(sock as never, req);
    return sock;
  }

  const ticket = { id: 't1', status: 'OPEN', userId: 'usr_1' } as never;
  const received = (sock: ReturnType<typeof fakeSocket>) =>
    sock.send.mock.calls
      .map(([raw]) => (JSON.parse(raw as string) as { type: string }).type)
      .filter((t) => t === 'NEW_SOURCING_TICKET').length;

  beforeEach(() => {
    auth = { authenticate: jest.fn(), stillValid: jest.fn() };
    const tokens = {
      onRevoked: jest.fn((l: (r: AdminRevocation) => void) => (revoke = l)),
    };
    gateway = new AdminEventsGateway(auth as never, tokens as never);
    gateway.onModuleInit();
  });

  it('a deactivated admin (all sessions revoked) loses the socket and gets no further tickets', async () => {
    const gone = await connect(session('adm_1'));
    const stays = await connect(session('adm_2'));

    revoke({ adminId: 'adm_1' });
    gateway.notifyAdminsNewTicket(ticket);

    expect(gone.close).toHaveBeenCalledWith(4401, 'session_revoked');
    expect(received(gone)).toBe(0);
    expect(stays.close).not.toHaveBeenCalled();
    expect(received(stays)).toBe(1);
  });

  it('logout and "sign out this device" close only the matching socket', async () => {
    const laptop = await connect(session('adm_1', { jti: 'a', sid: 's1' }));
    const phone = await connect(session('adm_1', { jti: 'b', sid: 's2' }));

    revoke({ jti: 'a' });
    expect(laptop.close).toHaveBeenCalledWith(4401, 'session_revoked');
    expect(phone.close).not.toHaveBeenCalled();

    revoke({ sid: 's2' });
    expect(phone.close).toHaveBeenCalledWith(4401, 'session_revoked');
  });

  it('the heartbeat does not carry a socket past its token expiry', async () => {
    jest.useFakeTimers();
    try {
      gateway.afterInit({ on: jest.fn() } as never);
      const sock = await connect(
        session('adm_1', { exp: Math.floor(Date.now() / 1000) + 10 }),
      );
      jest.advanceTimersByTime(30_000);
      expect(sock.close).toHaveBeenCalledWith(4401, 'token_expired');
    } finally {
      jest.useRealTimers();
    }
  });

  it('revalidates every open socket in one batch and closes the stale ones', async () => {
    const stale = await connect(session('adm_1'));
    const live = await connect(session('adm_2'));
    auth.stillValid.mockResolvedValue([false, true]);

    await gateway.revalidate();

    expect(auth.stillValid).toHaveBeenCalledTimes(1);
    expect(stale.close).toHaveBeenCalledWith(4401, 'session_revoked');
    expect(live.close).not.toHaveBeenCalled();
  });

  it('closes rather than keeps sockets it cannot revalidate', async () => {
    const sock = await connect(session('adm_1'));
    auth.stillValid.mockRejectedValue(new Error('Redis down'));
    await gateway.revalidate();
    expect(sock.close).toHaveBeenCalledWith(1013, 'unavailable');
    gateway.notifyAdminsNewTicket(ticket);
    expect(received(sock)).toBe(0);
  });

  it('refuses an unauthenticated handshake (4401) and an unverifiable one (1013)', async () => {
    auth.authenticate.mockRejectedValueOnce(new UnauthorizedException());
    const denied = fakeSocket();
    await gateway.handleConnection(denied as never, req);
    expect(denied.close).toHaveBeenCalledWith(4401, 'unauthorized');

    auth.authenticate.mockRejectedValueOnce(new Error('Redis down'));
    const unknown = fakeSocket();
    await gateway.handleConnection(unknown as never, req);
    expect(unknown.close).toHaveBeenCalledWith(1013, 'unavailable');
  });

  it('a spoofed X-Forwarded-For does not reset the handshake limit', async () => {
    auth.authenticate.mockResolvedValue(session('adm_1'));
    const from = (i: number) =>
      ({
        url: '/admin-events',
        headers: { 'x-forwarded-for': `198.51.100.${i}` },
        socket: { remoteAddress: '203.0.113.9' },
      }) as never;
    for (let i = 0; i < 30; i++) {
      await gateway.handleConnection(fakeSocket() as never, from(i));
    }
    const blocked = fakeSocket();
    await gateway.handleConnection(blocked as never, from(200));
    expect(blocked.close).toHaveBeenCalledWith(4429, 'rate_limited');
  });
});

describe('AdminWsAuthService', () => {
  const jwt = new JwtService({});
  const config = { secret: SECRET };
  let prisma: { appAdmin: { findUnique: jest.Mock; findMany: jest.Mock } };
  let tokens: { isAccessTokenRevoked: jest.Mock };
  let redis: { existsEach: jest.Mock };
  let service: AdminWsAuthService;
  let token: string;

  beforeEach(async () => {
    prisma = {
      appAdmin: {
        findUnique: jest.fn().mockResolvedValue({
          tokenVersion: 1,
          isActive: true,
          role: AdminRole.OPERATOR,
        }),
        findMany: jest.fn(),
      },
    };
    tokens = { isAccessTokenRevoked: jest.fn().mockResolvedValue(false) };
    redis = { existsEach: jest.fn() };
    service = new AdminWsAuthService(
      jwt,
      prisma as never,
      config as never,
      tokens as never,
      redis as never,
    );
    token = await jwt.signAsync(
      { sub: 'adm_1', type: 'admin', tokenVersion: 1, jti: 'j', sid: 's' },
      {
        algorithm: 'HS256',
        secret: SECRET,
        expiresIn: 900,
        issuer: ADMIN_JWT_ISSUER,
        audience: ADMIN_JWT_AUDIENCE,
      },
    );
  });

  it('accepts the token from the Authorization header or the bearer subprotocol', async () => {
    for (const headers of [
      { authorization: `Bearer ${token}` },
      { 'sec-websocket-protocol': `mator.bearer, ${token}` },
    ]) {
      await expect(
        service.authenticate({ url: '/admin-events', headers } as never),
      ).resolves.toMatchObject({ adminId: 'adm_1', jti: 'j', sid: 's' });
    }
  });

  it('does not accept a token in the query string, where access logs would record it', async () => {
    await expect(
      service.authenticate({
        url: `/admin-events?token=${token}`,
        headers: {},
      } as never),
    ).rejects.toThrow('Missing token');
  });

  it('refuses a revoked token, a deactivated admin and a stale session version', async () => {
    const request = {
      url: '/admin-events',
      headers: { authorization: `Bearer ${token}` },
    } as never;

    tokens.isAccessTokenRevoked.mockResolvedValueOnce(true);
    await expect(service.authenticate(request)).rejects.toThrow(
      'Token revoked',
    );

    prisma.appAdmin.findUnique.mockResolvedValueOnce({
      tokenVersion: 1,
      isActive: false,
      role: AdminRole.OPERATOR,
    });
    await expect(service.authenticate(request)).rejects.toThrow(
      'Token revoked',
    );

    prisma.appAdmin.findUnique.mockResolvedValueOnce({
      tokenVersion: 2,
      isActive: true,
      role: AdminRole.OPERATOR,
    });
    await expect(service.authenticate(request)).rejects.toThrow(
      'Token revoked',
    );
  });

  it('stillValid: one query and one Redis round trip decide every socket', async () => {
    prisma.appAdmin.findMany.mockResolvedValue([
      { id: 'a', tokenVersion: 1, isActive: true },
      { id: 'b', tokenVersion: 1, isActive: false },
      { id: 'c', tokenVersion: 5, isActive: true },
    ]);
    const s = (adminId: string, jti: string, sid: string) => ({
      adminId,
      role: AdminRole.OPERATOR,
      tokenVersion: 1,
      jti,
      sid,
    });
    // [jti, sid] per session: the 4th has a blacklisted jti, the 5th a revoked sid.
    redis.existsEach.mockResolvedValue([
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      false,
      false,
      true,
      false,
      false,
    ]);

    await expect(
      service.stillValid([
        s('a', 'j1', 's1'), // fine
        s('b', 'j2', 's2'), // deactivated
        s('c', 'j3', 's3'), // version moved on
        s('a', 'j4', 's4'), // logged out
        s('a', 'j5', 's5'), // device signed out
        s('gone', 'j6', 's6'), // deleted
      ]),
    ).resolves.toEqual([true, false, false, false, false, false]);
    expect(prisma.appAdmin.findMany).toHaveBeenCalledTimes(1);
    expect(redis.existsEach).toHaveBeenCalledTimes(1);
  });
});
