import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import type { IncomingMessage } from 'http';
import { WebSocket, WebSocketServer, RawData } from 'ws';
import { WsAuthService } from './ws-auth.service';

const HEARTBEAT_MS = 30_000;

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

/**
 * Native-`ws` realtime gateway. Clients connect to
 * `wss://…/realtime?channel=garage:{user_id}&token=<jwt>`; the channel's user id
 * must match the authenticated token. Heartbeat is protocol-level ping/pong: the
 * server pings every 30s and terminates sockets that miss a pong. App-level
 * `{"type":"ping"}` messages are also answered with `{"type":"pong"}`.
 */
@WebSocketGateway({ path: '/realtime' })
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(RealtimeGateway.name);
  // userId -> live sockets (a user may have several devices/tabs connected).
  private readonly sockets = new Map<string, Set<TrackedSocket>>();
  private heartbeat?: ReturnType<typeof setInterval>;

  constructor(private readonly wsAuth: WsAuthService) {}

  afterInit(server: WebSocketServer): void {
    this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT_MS);
    // Stop the timer when the server closes so tests/shutdown don't hang.
    server.on('close', () => this.heartbeat && clearInterval(this.heartbeat));
  }

  async handleConnection(client: TrackedSocket, request: IncomingMessage): Promise<void> {
    let userId: string;
    try {
      userId = await this.wsAuth.authenticate(request);
    } catch {
      return this.reject(client, CLOSE_UNAUTHORIZED, 'unauthorized');
    }

    const channel = new URL(request.url ?? '', 'http://localhost').searchParams.get('channel');
    const match = channel ? /^garage:(.+)$/.exec(channel) : null;
    if (!match) return this.reject(client, CLOSE_BAD_REQUEST, 'invalid_channel');
    if (match[1] !== userId) return this.reject(client, CLOSE_FORBIDDEN_CHANNEL, 'forbidden_channel');

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
