import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
} from '@nestjs/websockets';
import { Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import type { IncomingMessage } from 'http';
import { WebSocket, WebSocketServer, RawData } from 'ws';
import { TokenService } from '../auth/tokens/token.service';
import { WsAuthService, WsSession } from './ws-auth.service';
import {
  HandshakeLimiter,
  selectWsProtocol,
  trustedProxyList,
  wsClientIp,
} from '../common/ws-handshake.util';

const HEARTBEAT_MS = 30_000;
/**
 * Every this many heartbeats (5 minutes) the open sockets are re-checked against
 * the database and the blacklist in one batch. Logout and logout-all close their
 * sockets at once through the TokenService listeners; this pass is the backstop
 * for a revocation this process did not see, at a cost of one query and one
 * Redis round trip per pass, not per socket.
 */
const REVALIDATE_EVERY_BEATS = 10;

// ── Tunable limits (change here) ──────────────────────────────────────────────
/**
 * Max WebSocket frame size accepted from a client. Our only inbound message is
 * `{"type":"ping"}` (a few dozen bytes); 32 KB leaves generous headroom for any
 * future small control frame while making the 100 MB `ws` default — a
 * memory-DoS vector where one frame is buffered whole before parsing —
 * impossible. Passed straight to the `ws.Server` constructor by `WsAdapter`.
 */
const MAX_PAYLOAD_BYTES = 32 * 1024; // 32 KB

/**
 * Max simultaneous sockets per authenticated user. Covers a handful of
 * devices/tabs (phone, tablet, web) with room to spare; beyond this a single
 * token is almost certainly leaking or abusive. Additional connections are
 * rejected with {@link CLOSE_TOO_MANY_CONNECTIONS}; existing sockets are
 * untouched.
 */
const MAX_CONNECTIONS_PER_USER = 15;

/**
 * Handshake rate limit per client IP: at most {@link HANDSHAKE_LIMIT} upgrade
 * attempts per {@link HANDSHAKE_WINDOW_MS}. Counts *both* successful and failed
 * attempts, so it also throttles credential-stuffing / churn from a single
 * source. The sliding-window state is pruned automatically (see `sweep()`).
 */
const HANDSHAKE_LIMIT = 30;
const HANDSHAKE_WINDOW_MS = 60_000; // 1 minute

/** Per-socket bookkeeping attached to the raw `ws` instance. */
interface TrackedSocket extends WebSocket {
  userId?: string;
  channel?: string;
  isAlive?: boolean;
  session?: WsSession;
}

/** A server→client event frame. */
export interface RealtimeEvent {
  type: string;
  data?: unknown;
}

// App-defined WS close codes (4000–4999 range).
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_FORBIDDEN_CHANNEL = 4403;
const CLOSE_BAD_REQUEST = 4400;
const CLOSE_TOO_MANY_CONNECTIONS = 4408; // per-user simultaneous cap reached
const CLOSE_RATE_LIMITED = 4429; // handshake rate limit (mirrors HTTP 429)
const CLOSE_SESSION_REVOKED = 4401; // sessions revoked while the socket was open
/** Standard "try again later": the check could not be made, the token may be fine. */
const CLOSE_TRY_AGAIN = 1013;

/**
 * Native-`ws` realtime gateway. Clients connect to
 * `wss://…/realtime?channel=garage:{user_id}` and present the access token as
 * the `mator.bearer` subprotocol (or an Authorization header); the channel's user
 * id must match the authenticated token. Heartbeat is protocol-level ping/pong: the
 * server pings every 30s and terminates sockets that miss a pong. App-level
 * `{"type":"ping"}` messages are also answered with `{"type":"pong"}`.
 */
// `maxPayload` (and any other option besides `path`/`server`/`namespace`) is
// forwarded verbatim to the underlying `ws.Server` constructor by `WsAdapter`.
@WebSocketGateway({
  path: '/realtime',
  maxPayload: MAX_PAYLOAD_BYTES,
  handleProtocols: selectWsProtocol,
})
export class RealtimeGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleInit
{
  private readonly logger = new Logger(RealtimeGateway.name);
  // userId -> live sockets (a user may have several devices/tabs connected).
  private readonly sockets = new Map<string, Set<TrackedSocket>>();
  // Sliding-window handshake limit per client address, pruned in `sweep()`.
  private readonly handshakes = new HandshakeLimiter(
    HANDSHAKE_LIMIT,
    HANDSHAKE_WINDOW_MS,
  );
  private readonly trustedProxies = trustedProxyList(process.env.TRUST_PROXY);
  private heartbeat?: ReturnType<typeof setInterval>;
  private beats = 0;

  constructor(
    private readonly wsAuth: WsAuthService,
    private readonly tokens: TokenService,
  ) {}

  /**
   * The token check in {@link WsAuthService} only runs at handshake, so an
   * already-open socket would otherwise keep streaming after its session was
   * revoked. Subscribing here closes that gap without AuthModule needing to
   * know the realtime transport exists (the dependency stays one-way:
   * RealtimeModule -> AuthModule).
   */
  onModuleInit(): void {
    this.tokens.onSessionsRevoked((userId) => this.disconnectUser(userId));
    this.tokens.onAccessTokenRevoked((jti) => this.disconnectToken(jti));
  }

  afterInit(server: WebSocketServer): void {
    this.heartbeat = setInterval(() => void this.sweep(), HEARTBEAT_MS);
    // Stop the timer when the server closes so tests/shutdown don't hang.
    server.on('close', () => this.heartbeat && clearInterval(this.heartbeat));
  }

  async handleConnection(
    client: TrackedSocket,
    request: IncomingMessage,
  ): Promise<void> {
    // Rate-limit the handshake *before* authenticating so failed/abusive
    // attempts are throttled too, not just successful ones.
    if (this.handshakes.hit(wsClientIp(request, this.trustedProxies))) {
      return this.reject(client, CLOSE_RATE_LIMITED, 'rate_limited');
    }

    let session: WsSession;
    try {
      session = await this.wsAuth.authenticate(request);
    } catch (err) {
      // Only a refused token is "unauthorized", which the app treats as final.
      // Redis or the database being unreachable is not a verdict on the token.
      return err instanceof UnauthorizedException
        ? this.reject(client, CLOSE_UNAUTHORIZED, 'unauthorized')
        : this.reject(client, CLOSE_TRY_AGAIN, 'unavailable');
    }
    const userId = session.userId;

    const channel = new URL(
      request.url ?? '',
      'http://localhost',
    ).searchParams.get('channel');
    const match = channel ? /^garage:(.+)$/.exec(channel) : null;
    if (!match)
      return this.reject(client, CLOSE_BAD_REQUEST, 'invalid_channel');
    if (match[1] !== userId)
      return this.reject(client, CLOSE_FORBIDDEN_CHANNEL, 'forbidden_channel');

    // Cap simultaneous sockets per user. Existing connections are left intact;
    // only the new one over the limit is rejected.
    if ((this.sockets.get(userId)?.size ?? 0) >= MAX_CONNECTIONS_PER_USER) {
      return this.reject(
        client,
        CLOSE_TOO_MANY_CONNECTIONS,
        'too_many_connections',
      );
    }

    client.userId = userId;
    client.session = session;
    client.channel = channel!;
    client.isAlive = true;
    client.on('pong', () => (client.isAlive = true));
    client.on('message', (raw) => this.onMessage(client, raw));

    this.track(userId, client);
    this.sendTo(client, { type: 'connected', data: { channel } });
    this.logger.debug(`WS connected user=${userId} channel=${channel}`);
  }

  handleDisconnect(client: TrackedSocket): void {
    if (!client.userId) return;
    const set = this.sockets.get(client.userId);
    set?.delete(client);
    if (set && set.size === 0) this.sockets.delete(client.userId);
  }

  /**
   * Close every live socket of a user whose sessions were revoked, and forget
   * them. Their access token is already dead for HTTP; this stops the realtime
   * channel it opened before the revocation. Returns how many were closed.
   */
  disconnectUser(userId: string): number {
    const set = this.sockets.get(userId);
    if (!set) return 0;
    for (const client of set) {
      this.reject(client, CLOSE_SESSION_REVOKED, 'session_revoked');
    }
    // Drop the bookkeeping now rather than waiting for each close event.
    this.sockets.delete(userId);
    this.logger.log(
      `WS disconnected ${set.size} socket(s) for user=${userId} (session revoked)`,
    );
    return set.size;
  }

  /** Close the sockets opened with one access token (single-device logout). */
  disconnectToken(jti: string): number {
    let closed = 0;
    for (const client of this.allSockets()) {
      if (client.session?.jti !== jti) continue;
      this.drop(client, CLOSE_SESSION_REVOKED, 'session_revoked');
      closed++;
    }
    return closed;
  }

  /** Push a garage event to every live socket of the given user. */
  emitGarageEvent(userId: string, type: string, data: unknown): void {
    this.emit(userId, { type, data });
  }

  /** Push an arbitrary event frame to a user's sockets. */
  emit(userId: string, event: RealtimeEvent): void {
    const set = this.sockets.get(userId);
    if (!set) return;
    for (const client of set) this.sendTo(client, event);
  }

  // ── internals ───────────────────────────────────────────────────────────────
  private onMessage(client: TrackedSocket, raw: RawData): void {
    let parsed: { type?: string };
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return; // ignore non-JSON frames
    }
    if (parsed.type === 'ping') {
      this.sendTo(client, { type: 'pong', data: { ts: Date.now() } });
    }
  }

  private allSockets(): TrackedSocket[] {
    return [...this.sockets.values()].flatMap((set) => [...set]);
  }

  /** Close a tracked socket and forget it without waiting for the close event. */
  private drop(client: TrackedSocket, code: number, reason: string): void {
    this.reject(client, code, reason);
    this.handleDisconnect(client);
  }

  private async sweep(): Promise<void> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (const client of this.allSockets()) {
      // The access token ran out: the socket goes with it. The app reconnects
      // with the token its refresh produced.
      if (client.session?.exp && client.session.exp <= nowSeconds) {
        this.drop(client, CLOSE_UNAUTHORIZED, 'token_expired');
        continue;
      }
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      try {
        client.ping();
      } catch {
        client.terminate();
      }
    }
    this.handshakes.prune();
    if (++this.beats % REVALIDATE_EVERY_BEATS === 0) await this.revalidate();
  }

  /** Batch re-check of every open socket; see {@link REVALIDATE_EVERY_BEATS}. */
  async revalidate(): Promise<void> {
    const open = this.allSockets().filter((c) => c.session);
    if (open.length === 0) return;
    let verdicts: boolean[];
    try {
      verdicts = await this.wsAuth.stillValid(open.map((c) => c.session!));
    } catch (err) {
      // Could not check: the sockets are closed as "try again", and the app
      // reconnects through the handshake, which makes the same checks.
      this.logger.warn(
        `WS revalidation unavailable, closing ${open.length} socket(s): ${String(err)}`,
      );
      for (const client of open) this.drop(client, CLOSE_TRY_AGAIN, 'unavailable');
      return;
    }
    open.forEach((client, i) => {
      if (!verdicts[i]) this.drop(client, CLOSE_SESSION_REVOKED, 'session_revoked');
    });
  }

  private track(userId: string, client: TrackedSocket): void {
    const set = this.sockets.get(userId) ?? new Set<TrackedSocket>();
    set.add(client);
    this.sockets.set(userId, set);
  }

  private sendTo(client: TrackedSocket, event: RealtimeEvent): void {
    if (client.readyState !== WebSocket.OPEN) return;
    client.send(JSON.stringify({ ...event, ts: Date.now() }));
  }

  private reject(client: TrackedSocket, code: number, reason: string): void {
    try {
      this.sendTo(client, { type: 'error', data: { reason } });
      client.close(code, reason);
    } catch {
      client.terminate();
    }
  }
}
