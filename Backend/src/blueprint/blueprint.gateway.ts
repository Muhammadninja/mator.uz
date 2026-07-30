import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { IncomingMessage } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { BLUEPRINT_PULSE } from './db-telemetry.service';
import type { DbPulse } from './db-telemetry.service';
import { verifyTicket } from './blueprint-auth';

const HEARTBEAT_MS = 30_000;
const MAX_PAYLOAD_BYTES = 8 * 1024; // inbound is only pings; keep it tiny
const MAX_CLIENTS = 20; // a handful of operator dashboards, no more

// App-defined WS close codes (4000–4999), mirroring RealtimeGateway's scheme.
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_TOO_MANY_CONNECTIONS = 4408;

interface TrackedSocket extends WebSocket {
  isAlive?: boolean;
}

/**
 * Operator-only WebSocket that streams DB-operation pulses to the 3D blueprint.
 *
 * Native `ws` (not Socket.io) to match {@link RealtimeGateway} and the single
 * `WsAdapter` configured in `main.ts` — a second Socket.io adapter would
 * conflict. Auth is a short-lived HMAC ticket in the query string
 * (`/blueprint?ticket=<exp>.<sig>`), since browsers can't send WS headers.
 *
 * This gateway only *broadcasts*; the sole inbound message is `{"type":"ping"}`,
 * answered with `pong`. Pulses arrive via EventEmitter2 (`@OnEvent`) from
 * {@link DbTelemetryService}, decoupling the Prisma middleware from the socket
 * layer.
 */
@WebSocketGateway({ path: '/blueprint', maxPayload: MAX_PAYLOAD_BYTES })
export class BlueprintGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(BlueprintGateway.name);
  private readonly clients = new Set<TrackedSocket>();
  private heartbeat?: ReturnType<typeof setInterval>;

  afterInit(server: WebSocketServer): void {
    this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT_MS);
    server.on('close', () => this.heartbeat && clearInterval(this.heartbeat));
  }

  handleConnection(client: TrackedSocket, request: IncomingMessage): void {
    const ticket = new URL(request.url ?? '', 'http://localhost').searchParams.get(
      'ticket',
    );
    if (!verifyTicket(ticket)) {
      return this.reject(client, CLOSE_UNAUTHORIZED, 'unauthorized');
    }
    if (this.clients.size >= MAX_CLIENTS) {
      return this.reject(client, CLOSE_TOO_MANY_CONNECTIONS, 'too_many_connections');
    }

    client.isAlive = true;
    client.on('pong', () => (client.isAlive = true));
    client.on('message', (raw) => {
      try {
        if (JSON.parse(raw.toString())?.type === 'ping') {
          this.send(client, { type: 'pong', data: { ts: Date.now() } });
        }
      } catch {
        /* ignore non-JSON frames */
      }
    });

    this.clients.add(client);
    this.send(client, { type: 'connected', data: { at: Date.now() } });
    this.logger.debug(`blueprint WS connected (${this.clients.size} total)`);
  }

  handleDisconnect(client: TrackedSocket): void {
    this.clients.delete(client);
  }

  /**
   * Fan a DB pulse out to every connected operator. Registered on EventEmitter2
   * by NestJS; the emit happens in {@link DbTelemetryService}. No-op when nobody
   * is watching, so telemetry costs nothing until a dashboard is open.
   */
  @OnEvent(BLUEPRINT_PULSE, { async: false })
  onPulse(pulse: DbPulse): void {
    if (this.clients.size === 0) return;
    const frame = JSON.stringify({ type: 'pulse', data: pulse });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(frame);
    }
  }

  // ── internals ────────────────────────────────────────────────────────────────
  private send(client: TrackedSocket, event: { type: string; data?: unknown }): void {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event));
  }

  private reject(client: TrackedSocket, code: number, reason: string): void {
    try {
      this.send(client, { type: 'error', data: { reason } });
      client.close(code, reason);
    } catch {
      client.terminate();
    }
  }

  private sweep(): void {
    for (const client of this.clients) {
      if (client.isAlive === false) {
        client.terminate();
        this.clients.delete(client);
        continue;
      }
      client.isAlive = false;
      try {
        client.ping();
      } catch {
        client.terminate();
        this.clients.delete(client);
      }
    }
  }
}
