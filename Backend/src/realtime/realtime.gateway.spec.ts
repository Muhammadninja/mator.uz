// Socket tracking in RealtimeGateway: a socket that is gone must not stay in
// the per-user map, where it would count against the per-user cap for good.
// The wider gateway behaviour is covered by test/smoke/realtime.e2e-spec.ts.

import type { INestApplication } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import { TokenService } from '../auth/tokens/token.service';
import { RealtimeGateway } from './realtime.gateway';
import { WsAuthService, type WsSession } from './ws-auth.service';

const CAP = 15; // MAX_CONNECTIONS_PER_USER

function fakeSocket() {
  return {
    readyState: WebSocket.OPEN as number,
    on: jest.fn(),
    send: jest.fn(),
    close: jest.fn(),
    terminate: jest.fn(),
    ping: jest.fn(),
  };
}
type FakeSocket = ReturnType<typeof fakeSocket>;

const session = (userId: string): WsSession => ({
  userId,
  tokenVersion: 0,
  jti: `jti-${userId}-${Math.random()}`,
  exp: Math.floor(Date.now() / 1000) + 3600,
});

describe('RealtimeGateway socket tracking', () => {
  let gateway: RealtimeGateway;
  let wsAuth: { authenticate: jest.Mock; stillValid: jest.Mock };
  let ip = 0;
  // A fresh address per handshake keeps the per-IP limit out of the picture.
  const request = (userId = 'usr_1') =>
    ({
      url: `/realtime?channel=garage:${userId}`,
      headers: {},
      socket: { remoteAddress: `10.0.${Math.floor(ip / 250)}.${ip++ % 250}` },
    }) as never;

  async function connect(userId = 'usr_1') {
    wsAuth.authenticate.mockResolvedValueOnce(session(userId));
    const sock = fakeSocket();
    await gateway.handleConnection(sock as never, request(userId));
    return sock;
  }

  /** Frame types the gateway sent to a socket, in order. */
  const frames = (sock: FakeSocket) =>
    sock.send.mock.calls.map(
      ([raw]) => (JSON.parse(raw as string) as { type: string }).type,
    );

  /** Simulate the client answering the protocol-level ping. */
  const pong = (sock: FakeSocket) =>
    (sock.on.mock.calls as [string, () => void][]).find(
      ([event]) => event === 'pong',
    )![1]();

  /** The user still has room for one more socket. */
  async function expectRoomForOneMore() {
    const next = await connect();
    expect(next.close).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    wsAuth = { authenticate: jest.fn(), stillValid: jest.fn() };
    const tokens = {
      onSessionsRevoked: jest.fn(),
      onAccessTokenRevoked: jest.fn(),
    };
    gateway = new RealtimeGateway(wsAuth as never, tokens as never);
  });

  // Nest runs handleDisconnect on the close event, which can fire while
  // handleConnection is still awaiting the token check.
  it('a socket that closes while its token is checked is never tracked', async () => {
    for (let i = 0; i < CAP; i++) {
      let finish!: (s: WsSession) => void;
      wsAuth.authenticate.mockReturnValueOnce(
        new Promise<WsSession>((resolve) => (finish = resolve)),
      );
      const ghost = fakeSocket();
      const pending = gateway.handleConnection(ghost as never, request());

      ghost.readyState = WebSocket.CLOSED;
      gateway.handleDisconnect(ghost as never);
      finish(session('usr_1'));
      await pending;

      expect(ghost.on).not.toHaveBeenCalled();
      expect(ghost.send).not.toHaveBeenCalled();
    }

    await gateway.revalidate();
    expect(wsAuth.stillValid).not.toHaveBeenCalled();
    await expectRoomForOneMore();
  });

  it('a socket still closing after the token check is not tracked either', async () => {
    let finish!: (s: WsSession) => void;
    wsAuth.authenticate.mockReturnValueOnce(
      new Promise<WsSession>((resolve) => (finish = resolve)),
    );
    const closing = fakeSocket();
    const pending = gateway.handleConnection(closing as never, request());
    closing.readyState = WebSocket.CLOSING;
    finish(session('usr_1'));
    await pending;

    gateway.emitGarageEvent('usr_1', 'vehicle.updated', {});
    expect(closing.send).not.toHaveBeenCalled();
    await gateway.revalidate();
    expect(wsAuth.stillValid).not.toHaveBeenCalled();
  });

  it('the heartbeat forgets sockets that closed without reaching handleDisconnect', async () => {
    jest.useFakeTimers();
    try {
      gateway.afterInit({ on: jest.fn() } as never);
      const socks: FakeSocket[] = [];
      for (let i = 0; i < CAP; i++) socks.push(await connect());
      for (const s of socks) s.readyState = WebSocket.CLOSED;

      jest.advanceTimersByTime(30_000);
      for (const s of socks) expect(s.ping).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
    await expectRoomForOneMore();
  });

  it('the heartbeat forgets an unresponsive socket when it terminates it', async () => {
    jest.useFakeTimers();
    try {
      gateway.afterInit({ on: jest.fn() } as never);
      const socks: FakeSocket[] = [];
      for (let i = 0; i < CAP; i++) socks.push(await connect());

      jest.advanceTimersByTime(30_000); // ping, mark not alive
      jest.advanceTimersByTime(30_000); // no pong: terminate
      for (const s of socks) expect(s.terminate).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
    // terminate() emits close only later; the slot is free already.
    await expectRoomForOneMore();
  });

  it('a ping that throws terminates and forgets that socket alone', async () => {
    jest.useFakeTimers();
    try {
      gateway.afterInit({ on: jest.fn() } as never);
      const broken = await connect();
      const fine = await connect();
      broken.ping.mockImplementation(() => {
        throw new Error('not open');
      });
      jest.advanceTimersByTime(30_000);
      expect(broken.terminate).toHaveBeenCalledTimes(1);
      expect(fine.terminate).not.toHaveBeenCalled();

      gateway.emitGarageEvent('usr_1', 'vehicle.updated', {});
      expect(frames(broken)).not.toContain('vehicle.updated');
      expect(frames(fine)).toContain('vehicle.updated');
    } finally {
      jest.useRealTimers();
    }
  });

  it('cleanup touches only the socket that went: not the user’s others, not other users', async () => {
    const phone = await connect('usr_1');
    const tablet = await connect('usr_1');
    const stranger = await connect('usr_2');

    // A third usr_1 socket that leaves during its token check.
    let finish!: (s: WsSession) => void;
    wsAuth.authenticate.mockReturnValueOnce(
      new Promise<WsSession>((resolve) => (finish = resolve)),
    );
    const ghost = fakeSocket();
    const pending = gateway.handleConnection(ghost as never, request('usr_1'));
    ghost.readyState = WebSocket.CLOSED;
    gateway.handleDisconnect(ghost as never);
    finish(session('usr_1'));
    await pending;

    // The phone closes normally; its close event arrives twice (terminate, then
    // the socket's own close), which must stay harmless.
    phone.readyState = WebSocket.CLOSED;
    gateway.handleDisconnect(phone as never);
    gateway.handleDisconnect(phone as never);

    gateway.emitGarageEvent('usr_1', 'vehicle.updated', {});
    gateway.emitGarageEvent('usr_2', 'vehicle.updated', {});
    expect(frames(tablet)).toEqual(['connected', 'vehicle.updated']);
    expect(frames(stranger)).toEqual(['connected', 'vehicle.updated']);
    expect(frames(phone)).toEqual(['connected']);

    wsAuth.stillValid.mockResolvedValue([true, true]);
    await gateway.revalidate();
    const checked = (wsAuth.stillValid.mock.calls[0][0] as WsSession[]).map(
      (s) => s.userId,
    );
    expect(checked.sort()).toEqual(['usr_1', 'usr_2']);
  });

  it('the heartbeat with several sockets terminates only the one that missed its pong', async () => {
    jest.useFakeTimers();
    try {
      gateway.afterInit({ on: jest.fn() } as never);
      const live = await connect();
      const silent = await connect();
      const other = await connect('usr_2');

      jest.advanceTimersByTime(30_000);
      for (const s of [live, silent, other])
        expect(s.ping).toHaveBeenCalledTimes(1);
      pong(live);
      pong(other);

      jest.advanceTimersByTime(30_000);
      expect(silent.terminate).toHaveBeenCalledTimes(1);
      expect(live.terminate).not.toHaveBeenCalled();
      expect(other.terminate).not.toHaveBeenCalled();
      expect(live.ping).toHaveBeenCalledTimes(2);
      expect(other.ping).toHaveBeenCalledTimes(2);

      gateway.emitGarageEvent('usr_1', 'vehicle.updated', {});
      expect(frames(live)).toContain('vehicle.updated');
      expect(frames(silent)).not.toContain('vehicle.updated');
    } finally {
      jest.useRealTimers();
    }
  });

  it('the cap still allows 15 live sockets, refuses the 16th, and frees a slot on close', async () => {
    const live: FakeSocket[] = [];
    for (let i = 0; i < CAP; i++) live.push(await connect());
    for (const s of live) expect(s.close).not.toHaveBeenCalled();

    const overflow = await connect();
    expect(overflow.close).toHaveBeenCalledWith(4408, 'too_many_connections');

    live[0].readyState = WebSocket.CLOSED;
    gateway.handleDisconnect(live[0] as never);
    await expectRoomForOneMore();
    const overflowAgain = await connect();
    expect(overflowAgain.close).toHaveBeenCalledWith(
      4408,
      'too_many_connections',
    );
  });
});

/** Poll until `cond` holds; real sockets settle on the event loop. */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// The same race on the real stack: Nest's WsAdapter binds `close` to
// handleDisconnect as soon as the socket connects, as in main.ts.
describe('RealtimeGateway on the real Nest ws stack', () => {
  let app: INestApplication;
  let gateway: RealtimeGateway;
  let disconnected: jest.SpyInstance;
  let url: string;
  const wsAuth = { authenticate: jest.fn(), stillValid: jest.fn() };

  beforeEach(async () => {
    wsAuth.authenticate.mockReset();
    wsAuth.stillValid.mockReset();
    const mod = await Test.createTestingModule({
      providers: [
        RealtimeGateway,
        { provide: WsAuthService, useValue: wsAuth },
        {
          provide: TokenService,
          useValue: {
            onSessionsRevoked: jest.fn(),
            onAccessTokenRevoked: jest.fn(),
          },
        },
      ],
    }).compile();
    gateway = mod.get(RealtimeGateway);
    // Before init: Nest binds the handler it finds then.
    disconnected = jest.spyOn(gateway, 'handleDisconnect');
    app = mod.createNestApplication({ logger: false });
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    url = `ws://127.0.0.1:${port}/realtime?channel=garage:usr_1`;
  });

  afterEach(() => app.close());

  it('a client that leaves during the token check is not tracked', async () => {
    let finish!: (s: WsSession) => void;
    wsAuth.authenticate.mockReturnValueOnce(
      new Promise<WsSession>((resolve) => (finish = resolve)),
    );
    const client = new WebSocket(url);
    await new Promise((resolve) => client.once('open', resolve));
    client.close();
    await until(() => disconnected.mock.calls.length === 1);

    finish(session('usr_1'));
    await new Promise((resolve) => setImmediate(resolve));

    await gateway.revalidate();
    expect(wsAuth.stillValid).not.toHaveBeenCalled();
  });

  it('a normal client is tracked, gets events and pongs, and is forgotten when it leaves', async () => {
    wsAuth.authenticate.mockResolvedValue(session('usr_1'));
    const client = new WebSocket(url);
    const got: string[] = [];
    client.on('message', (raw: Buffer) =>
      got.push((JSON.parse(raw.toString()) as { type: string }).type),
    );
    await until(() => got.includes('connected'));

    gateway.emitGarageEvent('usr_1', 'vehicle.updated', { id: 'veh_1' });
    client.send(JSON.stringify({ type: 'ping' }));
    await until(() => got.includes('vehicle.updated') && got.includes('pong'));

    wsAuth.stillValid.mockResolvedValue([true]);
    await gateway.revalidate();
    expect(wsAuth.stillValid).toHaveBeenCalledWith([
      expect.objectContaining({ userId: 'usr_1' }),
    ]);
    expect(client.readyState).toBe(WebSocket.OPEN);

    client.close();
    await until(() => disconnected.mock.calls.length === 1);
    wsAuth.stillValid.mockClear();
    await gateway.revalidate();
    expect(wsAuth.stillValid).not.toHaveBeenCalled();
  });
});
