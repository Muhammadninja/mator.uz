import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { parseSchema } from '../../scripts/parse-schema';

/** Emitted on EventEmitter2 for every (sampled) DB operation. */
export const BLUEPRINT_PULSE = 'blueprint.pulse';

export interface DbPulse {
  /** Prisma model name, e.g. "Order" (mapped back from the SQL table). */
  model: string | null;
  /** Coarse operation inferred from the SQL verb: read | create | update | delete. */
  operation: string;
  /** Duration of the query in milliseconds (from Prisma's query event). */
  durationMs: number;
  /** Epoch ms when the query completed. */
  at: number;
}

/** Shape of Prisma's `query` event (avoids importing Prisma's event types). */
interface PrismaQueryEvent {
  query: string;
  params: string;
  duration: number;
  target: string;
}

/**
 * Turns the live Prisma query stream into blueprint pulses.
 *
 * ## Why the query event stream (not `$use`, not `$extends`)
 * Prisma 6 **removed** the `$use` middleware API, and a client extension
 * (`$extends`) returns a NEW client — it would leave the shared, app-wide
 * `PrismaService` singleton unmonitored unless every call site migrated. The
 * `query` event (enabled in {@link PrismaService} when the blueprint is on) fires
 * for every executed query on the existing instance, carrying the SQL and its
 * duration. We map the SQL's table back to a Prisma model via the schema graph
 * and emit a {@link DbPulse}. Lossy by design (see the rate cap): this is a
 * visualization feed, not an audit log.
 */
@Injectable()
export class DbTelemetryService implements OnModuleInit {
  private readonly logger = new Logger(DbTelemetryService.name);

  // Sliding 1s emission budget so a hot query loop can't flood the socket.
  private static readonly MAX_PULSES_PER_SEC = 200;
  private windowStart = 0;
  private windowCount = 0;

  // Postgres table name (lower-cased) → Prisma model id, built from the schema.
  private tableToModel = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  onModuleInit(): void {
    this.buildTableMap();

    const prisma = this.prisma as unknown as {
      $on?: (event: 'query', cb: (e: PrismaQueryEvent) => void) => void;
    };
    if (typeof prisma.$on !== 'function') {
      this.logger.warn('PrismaClient.$on unavailable — blueprint pulses disabled.');
      return;
    }

    prisma.$on('query', (e) => this.onQuery(e));
    this.logger.log('DB telemetry listening on Prisma query events (blueprint pulses live).');
  }

  private buildTableMap(): void {
    try {
      const schemaPath = join(process.cwd(), 'prisma', 'schema.prisma');
      const graph = parseSchema(readFileSync(schemaPath, 'utf8'));
      for (const n of graph.nodes) this.tableToModel.set(n.table.toLowerCase(), n.id);
    } catch (err) {
      this.logger.warn(
        `Could not build table→model map (pulses will lack model names): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private onQuery(e: PrismaQueryEvent): void {
    const sql = e.query;
    const model = this.modelForSql(sql);
    // Skip infra noise (BEGIN/COMMIT/SET/health checks) — no user table.
    if (!model) return;

    const now = Date.now();
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    if (this.windowCount >= DbTelemetryService.MAX_PULSES_PER_SEC) return; // shed load
    this.windowCount++;

    const pulse: DbPulse = {
      model,
      operation: operationFromSql(sql),
      durationMs: Math.round(e.duration * 100) / 100,
      at: now,
    };
    this.events.emit(BLUEPRINT_PULSE, pulse);
  }

  /** Extract the primary table from the SQL and map it to a Prisma model id. */
  private modelForSql(sql: string): string | null {
    const table = tableFromSql(sql);
    if (!table) return null;
    return this.tableToModel.get(table.toLowerCase()) ?? null;
  }
}

// ── SQL parsing helpers (pure) ────────────────────────────────────────────────
// Grabs the token after FROM/INTO/UPDATE/JOIN — which Prisma emits as
// `"schema"."table"`, `"table"`, or bare `table`. DELETE/SELECT both surface via
// the `from` branch. Subqueries (`from (select …`) are excluded by stopping at `(`.
const TABLE_TOKEN_RE = /(?:\bfrom\b|\binto\b|\bupdate\b|\bjoin\b)\s+([^\s(;]+)/i;

/** First table referenced by the statement, unquoted and schema-stripped. */
function tableFromSql(sql: string): string | null {
  const m = TABLE_TOKEN_RE.exec(sql);
  if (!m) return null;
  // Take the identifier after the last `.` (drops the schema qualifier), unquote.
  const token = m[1];
  const last = token.slice(token.lastIndexOf('.') + 1).replace(/"/g, '');
  return /^[a-z0-9_]+$/i.test(last) ? last : null;
}

/** Coarse operation from the leading SQL verb. */
function operationFromSql(sql: string): string {
  const verb = sql.trimStart().slice(0, 6).toUpperCase();
  if (verb.startsWith('SELECT')) return 'read';
  if (verb.startsWith('INSERT')) return 'create';
  if (verb.startsWith('UPDATE')) return 'update';
  if (verb.startsWith('DELETE')) return 'delete';
  return 'other';
}
