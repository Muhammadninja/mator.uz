import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
} from '@nestjs/websockets';
import { Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import type { IncomingMessage } from 'http';
import { WebSocket, WebSocketServer, RawData } from 'ws';
import type { SourcingTicket } from '@prisma/client';
import {
  AdminWsAuthService,
  AuthenticatedAdmin,
} from './admin-ws-auth.service';
import {
  AdminRevocation,
  AdminTokenService,
} from '../admin/auth/admin-token.service';
import {
  HandshakeLimiter,
  selectWsProtocol,
  trustedProxyList,
  wsClientIp,
} from '../common/ws-handshake.util';

const HEARTBEAT_MS = 30_000;
/**
 * Every second heartbeat (60 s) the open admin sockets are re-checked in one
 * batch: account still active, session version unchanged, token and device not
 * revoked. Revocations made by this process close their sockets at once through
 * the AdminTokenService listener; this pass bounds how long a socket can outlive
 * one made anywhere else (another instance, a direct database change).
 */
const REVALIDATE_EVERY_BEATS = 2;
const MAX_PAYLOAD_BYTES = 32 * 1024; // 32 KB — our only inbound frame is a tiny ping.
const HANDSHAKE_LIMIT = 30;
const HANDSHAKE_WINDOW_MS = 60_000;

// App-defined WS close codes (4000–4999).
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_RATE_LIMITED = 4429;
/** Standard "try again later": the check could not be made. */
const CLOSE_TRY_AGAIN = 1013;

/** The realtime frame admins receive when a new sourcing ticket is opened. */
export const NEW_SOURCING_TICKET = 'NEW_SOURCING_TICKET';
export const SOURCING_TICKET_ESCALATED = 'SOURCING_TICKET_ESCALATED';

interface TrackedSocket extends WebSocket {
  adminId?: string;
  isAlive?: boolean;
  session?: AuthenticatedAdmin;
}

interface RealtimeEvent {
  type: string;
  data?: unknown;
}

/**
 * Native-`ws` admin realtime gateway. mator-admin connects to
 * `wss://…/admin-events` with an `Authorization: Bearer` header or the
 * `mator.bearer` subprotocol; a `?token=` query parameter is refused. Unlike the user RealtimeGateway there is no per-user channel — every
 * authenticated admin joins one broadcast pool and receives operational events
 * such as {@link NEW_SOURCING_TICKET}. Heartbeat and handshake rate-limiting
 * mirror the user gateway.
 */
@WebSocketGateway({
  path: '/admin-events',
  maxPayload: MAX_PAYLOAD_BYTES,
  handleProtocols: selectWsProtocol,
})
export class AdminEventsGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleInit
{
  private readonly logger = new Logger(AdminEventsGateway.name);
  private readonly admins = new Set<TrackedSocket>();
  private readonly handshakes = new HandshakeLimiter(
    HANDSHAKE_LIMIT,
    HANDSHAKE_WINDOW_MS,
  );
  private readonly trustedProxies = trustedProxyList(process.env.TRUST_PROXY);
  private heartbeat?: ReturnType<typeof setInterval>;
  private beats = 0;

  constructor(
    private readonly adminAuth: AdminWsAuthService,
    private readonly tokens: AdminTokenService,
  ) {}

  /**
   * Deactivation, a role or password change and logout-all revoke every session
   * of an admin; logout and "sign out this device" revoke one. Either way the
   * sockets opened with those credentials close now, not at the next heartbeat.
   */
  onModuleInit(): void {
    this.tokens.onRevoked((revoked) => this.disconnectRevoked(revoked));
  }

  afterInit(server: WebSocketServer): void {
    this.heartbeat = setInterval(() => void this.sweep(), HEARTBEAT_MS);
    server.on('close', () => this.heartbeat && clearInterval(this.heartbeat));
  }

  async handleConnection(
    client: TrackedSocket,
    request: IncomingMessage,
  ): Promise<void> {
    if (this.handshakes.hit(wsClientIp(request, this.trustedProxies))) {
      return this.reject(client, CLOSE_RATE_LIMITED, 'rate_limited');
    }

    let session: AuthenticatedAdmin;
    try {
      session = await this.adminAuth.authenticate(request);
    } catch (err) {
      return err instanceof UnauthorizedException
        ? this.reject(client, CLOSE_UNAUTHORIZED, 'unauthorized')
        : this.reject(client, CLOSE_TRY_AGAIN, 'unavailable');
    }
    const adminId = session.adminId;

    client.adminId = adminId;
    client.session = session;
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

  /** Close the sockets a revocation covers. Returns how many were closed. */
  disconnectRevoked(revoked: AdminRevocation): number {
    let closed = 0;
    for (const client of [...this.admins]) {
      const s = client.session;
      if (!s) continue;
      const hit =
        ('adminId' in revoked && s.adminId === revoked.adminId) ||
        ('jti' in revoked && s.jti === revoked.jti) ||
        ('sid' in revoked && s.sid === revoked.sid);
      if (!hit) continue;
      this.drop(client, CLOSE_UNAUTHORIZED, 'session_revoked');
      closed++;
    }
    return closed;
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

  notifyAdminsTicketEscalated(ticket: SourcingTicket): void {
    this.broadcast({
      type: SOURCING_TICKET_ESCALATED,
      data: {
        id: ticket.id,
        status: ticket.status,
        partName: ticket.partName,
        staffNotifyStatus: ticket.staffNotifyStatus,
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

  private drop(client: TrackedSocket, code: number, reason: string): void {
    this.reject(client, code, reason);
    this.admins.delete(client);
  }

  private async sweep(): Promise<void> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (const client of [...this.admins]) {
      // The heartbeat must not carry a socket past its access token's expiry.
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
    const open = [...this.admins].filter((c) => c.session);
    if (open.length === 0) return;
    let verdicts: boolean[];
    try {
      verdicts = await this.adminAuth.stillValid(open.map((c) => c.session!));
    } catch (err) {
      // Could not check: this channel carries buyer requests, so it closes
      // rather than stays open on an unverified session.
      this.logger.warn(
        `Admin WS revalidation unavailable, closing ${open.length} socket(s): ${String(err)}`,
      );
      for (const client of open) this.drop(client, CLOSE_TRY_AGAIN, 'unavailable');
      return;
    }
    open.forEach((client, i) => {
      if (!verdicts[i]) this.drop(client, CLOSE_UNAUTHORIZED, 'session_revoked');
    });
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
