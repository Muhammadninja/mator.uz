import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import type { IncomingMessage } from 'http';
import { WebSocket, WebSocketServer, RawData } from 'ws';
import type { SourcingTicket } from '@prisma/client';
import { AdminWsAuthService } from './admin-ws-auth.service';

const HEARTBEAT_MS = 30_000;
const MAX_PAYLOAD_BYTES = 32 * 1024; // 32 KB — our only inbound frame is a tiny ping.
const HANDSHAKE_LIMIT = 30;
const HANDSHAKE_WINDOW_MS = 60_000;

// App-defined WS close codes (4000–4999).
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_RATE_LIMITED = 4429;

/** The realtime frame admins receive when a new sourcing ticket is opened. */
export const NEW_SOURCING_TICKET = 'NEW_SOURCING_TICKET';

interface TrackedSocket extends WebSocket {
  adminId?: string;
  isAlive?: boolean;
}

interface RealtimeEvent {
  type: string;
  data?: unknown;
}

/**
 * Native-`ws` admin realtime gateway. mator-admin connects to
 * `wss://…/admin-events?token=<admin_jwt>` (or with an `Authorization: Bearer`
 * header). Unlike the user RealtimeGateway there is no per-user channel — every
 * authenticated admin joins one broadcast pool and receives operational events
 * such as {@link NEW_SOURCING_TICKET}. Heartbeat and handshake rate-limiting
 * mirror the user gateway.
 */
@WebSocketGateway({ path: '/admin-events', maxPayload: MAX_PAYLOAD_BYTES })
export class AdminEventsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(AdminEventsGateway.name);
  private readonly admins = new Set<TrackedSocket>();
  private readonly handshakes = new Map<string, number[]>();
  private heartbeat?: ReturnType<typeof setInterval>;

  constructor(private readonly adminAuth: AdminWsAuthService) {}

  afterInit(server: WebSocketServer): void {
    this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT_MS);
    server.on('close', () => this.heartbeat && clearInterval(this.heartbeat));
  }

  async handleConnection(
    client: TrackedSocket,
    request: IncomingMessage,
  ): Promise<void> {
    if (this.isRateLimited(this.clientIp(request))) {
      return this.reject(client, CLOSE_RATE_LIMITED, 'rate_limited');
    }

    let adminId: string;
    try {
      ({ adminId } = await this.adminAuth.authenticate(request));
    } catch {
      return this.reject(client, CLOSE_UNAUTHORIZED, 'unauthorized');
    }

    client.adminId = adminId;
    client.isAlive = true;
    client.on('pong', () => (client.isAlive = true));
    client.on('message', (raw) => this.onMessage(client, raw));

    this.admins.add(client);
    this.sendTo(client, { type: 'connected' });
    this.logger.debug(`Admin WS connected admin=${adminId}`);
  }

  handleDisconnect(client: TrackedSocket): void {
    this.admins.delete(client);
  }

  /**
   * Broadcast a newly-created sourcing ticket to every connected admin. Best
   * effort: never throws, so a realtime hiccup can't fail the chat request that
   * created the ticket (the ticket is already persisted).
   */
  notifyAdminsNewTicket(ticket: SourcingTicket): void {
    this.broadcast({
      type: NEW_SOURCING_TICKET,
      data: {
        id: ticket.id,
        status: ticket.status,
        userId: ticket.userId,
        rawMessage: ticket.rawMessage,
        extractedData: ticket.extractedData,
        createdAt: ticket.createdAt,
      },
    });
  }

  private broadcast(event: RealtimeEvent): void {
    for (const client of this.admins) this.sendTo(client, event);
  }

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

  private isRateLimited(ip: string): boolean {
    const cutoff = Date.now() - HANDSHAKE_WINDOW_MS;
    const recent = (this.handshakes.get(ip) ?? []).filter((t) => t > cutoff);
    recent.push(Date.now());
    this.handshakes.set(ip, recent);
    return recent.length > HANDSHAKE_LIMIT;
  }

  private clientIp(request: IncomingMessage): string {
    const fwd = request.headers['x-forwarded-for'];
    const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0];
    return first?.trim() || request.socket?.remoteAddress || 'unknown';
  }

  private sweep(): void {
    for (const client of this.admins) {
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
    const cutoff = Date.now() - HANDSHAKE_WINDOW_MS;
    for (const [ip, times] of this.handshakes) {
      const live = times.filter((t) => t > cutoff);
      if (live.length === 0) this.handshakes.delete(ip);
      else this.handshakes.set(ip, live);
    }
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
