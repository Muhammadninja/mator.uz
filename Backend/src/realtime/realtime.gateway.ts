import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
} from '@nestjs/websockets';
import { Logger, OnModuleInit } from '@nestjs/common';
import type { IncomingMessage } from 'http';
import { WebSocket, WebSocketServer, RawData } from 'ws';
import { TokenService } from '../auth/tokens/token.service';
import { WsAuthService } from './ws-auth.service';

const HEARTBEAT_MS = 30_000;

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

/**
 * Native-`ws` realtime gateway. Clients connect to
 * `wss://…/realtime?channel=garage:{user_id}&token=<jwt>`; the channel's user id
 * must match the authenticated token. Heartbeat is protocol-level ping/pong: the
 * server pings every 30s and terminates sockets that miss a pong. App-level
 * `{"type":"ping"}` messages are also answered with `{"type":"pong"}`.
 */
// `maxPayload` (and any other option besides `path`/`server`/`namespace`) is
// forwarded verbatim to the underlying `ws.Server` constructor by `WsAdapter`.
@WebSocketGateway({ path: '/realtime', maxPayload: MAX_PAYLOAD_BYTES })
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
  // clientIp -> recent handshake timestamps (ms), for sliding-window rate
  // limiting. Pruned in `sweep()` so it can't grow unbounded.
  private readonly handshakes = new Map<string, number[]>();
  private heartbeat?: ReturnType<typeof setInterval>;

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
  }

  afterInit(server: WebSocketServer): void {
    this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT_MS);
    // Stop the timer when the server closes so tests/shutdown don't hang.
    server.on('close', () => this.heartbeat && clearInterval(this.heartbeat));
  }

  async handleConnection(
    client: TrackedSocket,
    request: IncomingMessage,
  ): Promise<void> {
    // Rate-limit the handshake *before* authenticating so failed/abusive
    // attempts are throttled too, not just successful ones.
    if (this.isRateLimited(this.clientIp(request))) {
      return this.reject(client, CLOSE_RATE_LIMITED, 'rate_limited');
    }

    let userId: string;
    try {
      userId = await this.wsAuth.authenticate(request);
    } catch {
      return this.reject(client, CLOSE_UNAUTHORIZED, 'unauthorized');
    }

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

  /**
   * Sliding-window handshake rate limit keyed by client IP. Records this
   * attempt and returns true if the IP has exceeded {@link HANDSHAKE_LIMIT}
   * within {@link HANDSHAKE_WINDOW_MS}. Stale timestamps are dropped on every
   * call so the per-IP array stays bounded; empty IP entries are cleared here
   * and by the periodic prune in `sweep()`.
   */
  private isRateLimited(ip: string): boolean {
    const now = Date.now();
    const cutoff = now - HANDSHAKE_WINDOW_MS;
    const recent = (this.handshakes.get(ip) ?? []).filter((t) => t > cutoff);
    recent.push(now);
    this.handshakes.set(ip, recent);
    return recent.length > HANDSHAKE_LIMIT;
  }

  /**
   * Best-effort client IP. Behind Nginx (`trust proxy` is set for HTTP) the
   * real client is the first entry of `X-Forwarded-For`; fall back to the
   * socket's remote address for direct connections.
   */
  private clientIp(request: IncomingMessage): string {
    const fwd = request.headers['x-forwarded-for'];
    const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0];
    return first?.trim() || request.socket?.remoteAddress || 'unknown';
  }

  private sweep(): void {
    for (const set of this.sockets.values()) {
      for (const client of set) {
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
    }
    // Prune expired handshake windows so the map can't grow unbounded.
    const cutoff = Date.now() - HANDSHAKE_WINDOW_MS;
    for (const [ip, times] of this.handshakes) {
      const live = times.filter((t) => t > cutoff);
      if (live.length === 0) this.handshakes.delete(ip);
      else this.handshakes.set(ip, live);
    }
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
