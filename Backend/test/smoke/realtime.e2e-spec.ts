import { JwtService } from '@nestjs/jwt';
import { WebSocket } from 'ws';
import { WsAuthService } from '../../src/realtime/ws-auth.service';
import { RealtimeGateway } from '../../src/realtime/realtime.gateway';
import { TokenService } from '../../src/auth/tokens/token.service';
import { JwtKeyService } from '../../src/auth/tokens/jwt-key.service';
import { createPrismaMock, fakeConfig, PrismaMock } from '../utils/harness';

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

    beforeEach(async () => {
      prisma = createPrismaMock();
      keys = new JwtKeyService(fakeConfig());
      jwt = new JwtService({});
      prisma.refreshToken.create.mockResolvedValue({ id: 'rt' });
      const tokens = new TokenService(prisma, jwt, keys, fakeConfig());
      accessToken = (await tokens.issueSession({ id: 'usr_1', email: null, role: 'USER' })).accessToken;
    });

    it('authenticates a valid token from the query string', async () => {
      const wsAuth = new WsAuthService(jwt, keys, fakeConfig());
      const userId = await wsAuth.authenticate({
        url: `/realtime?channel=garage:usr_1&token=${accessToken}`,
        headers: {},
      } as any);
      expect(userId).toBe('usr_1');
    });

    it('rejects a missing/invalid token', async () => {
      const wsAuth = new WsAuthService(jwt, keys, fakeConfig());
      await expect(wsAuth.authenticate({ url: '/realtime?channel=garage:usr_1', headers: {} } as any)).rejects.toThrow();
      await expect(
        wsAuth.authenticate({ url: '/realtime?channel=garage:usr_1&token=garbage', headers: {} } as any),
      ).rejects.toThrow();
    });
  });

  describe('RealtimeGateway', () => {
    let gateway: RealtimeGateway;
    let wsAuth: { authenticate: jest.Mock };

    beforeEach(() => {
      wsAuth = { authenticate: jest.fn() };
      gateway = new RealtimeGateway(wsAuth as any);
    });

    it('accepts an authorized garage channel and pushes events to it', async () => {
      wsAuth.authenticate.mockResolvedValue('usr_1');
      const sock = fakeSocket();
      await gateway.handleConnection(sock as any, { url: '/realtime?channel=garage:usr_1', headers: {} } as any);

      const connected = JSON.parse(sock.send.mock.calls[0][0]);
      expect(connected.type).toBe('connected');

      gateway.emitGarageEvent('usr_1', 'vehicle.updated', { id: 'veh_1' });
      const frame = JSON.parse(sock.send.mock.calls[1][0]);
      expect(frame).toMatchObject({ type: 'vehicle.updated', data: { id: 'veh_1' } });
      expect(frame.ts).toEqual(expect.any(Number));
    });

    it('closes a channel that does not match the authenticated user (4403)', async () => {
      wsAuth.authenticate.mockResolvedValue('usr_1');
      const sock = fakeSocket();
      await gateway.handleConnection(sock as any, { url: '/realtime?channel=garage:someone_else', headers: {} } as any);
      expect(sock.close).toHaveBeenCalledWith(4403, 'forbidden_channel');
    });

    it('closes an unauthenticated connection (4401)', async () => {
      wsAuth.authenticate.mockRejectedValue(new Error('no token'));
      const sock = fakeSocket();
      await gateway.handleConnection(sock as any, { url: '/realtime?channel=garage:usr_1', headers: {} } as any);
      expect(sock.close).toHaveBeenCalledWith(4401, 'unauthorized');
    });

    it('answers an app-level ping with a pong', async () => {
      wsAuth.authenticate.mockResolvedValue('usr_1');
      const sock = fakeSocket();
      await gateway.handleConnection(sock as any, { url: '/realtime?channel=garage:usr_1', headers: {} } as any);
      sock.send.mockClear();

      sock.handlers['message'](Buffer.from(JSON.stringify({ type: 'ping' })));
      expect(JSON.parse(sock.send.mock.calls[0][0]).type).toBe('pong');
    });

    it('heartbeat pings live sockets and terminates unresponsive ones', async () => {
      jest.useFakeTimers();
      try {
        wsAuth.authenticate.mockResolvedValue('usr_1');
        gateway.afterInit({ on: jest.fn() } as any);
        const sock = fakeSocket();
        await gateway.handleConnection(sock as any, { url: '/realtime?channel=garage:usr_1', headers: {} } as any);

        jest.advanceTimersByTime(30_000); // first sweep: ping, mark not-alive
        expect(sock.ping).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(30_000); // second sweep: no pong came back -> terminate
        expect(sock.terminate).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
