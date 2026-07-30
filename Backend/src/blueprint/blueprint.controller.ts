import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiExcludeController } from '@nestjs/swagger';
import { BlueprintTokenGuard } from './blueprint-token.guard';
import { mintTicket } from './blueprint-auth';
import { buildBlueprint } from './schema-blueprint';
import type { BlueprintPayload } from './schema-blueprint';

/**
 * Operator-only HTTP surface for the 3D blueprint. Every route requires the
 * `x-blueprint-token` header ({@link BlueprintTokenGuard}); the admin proxies
 * these server-side so the token stays off the browser. Excluded from Swagger
 * so the internal tool isn't advertised in the public API docs.
 */
@ApiExcludeController()
@UseGuards(BlueprintTokenGuard)
@Controller('blueprint')
export class BlueprintController {
  // Parsing the 1.9k-line schema is cheap but pointless to repeat per request;
  // it only changes on deploy, so cache the first parse for the process's life.
  private payloadCache: BlueprintPayload | null = null;

  /** Domains + tables (with columns) + relations the 3D scene renders. */
  @Get('graph')
  getGraph(): BlueprintPayload {
    if (!this.payloadCache) {
      const schemaPath = join(process.cwd(), 'prisma', 'schema.prisma');
      const payload = buildBlueprint(readFileSync(schemaPath, 'utf8'));
      payload.generatedAt = new Date().toISOString();
      payload.migrationVersion = latestMigration();
      this.payloadCache = payload;
    }
    return this.payloadCache;
  }

  /**
   * Mint a short-lived WS ticket. Retained for the (optional) live-telemetry
   * layer; the schema view itself needs only {@link getGraph}. See
   * {@link mintTicket}.
   */
  @Post('ticket')
  getTicket(): { ticket: string; expiresAt: number } {
    return mintTicket();
  }
}

/** Newest `prisma/migrations/<timestamp>_name` folder, for the header meta. */
function latestMigration(): string | null {
  try {
    const dir = join(process.cwd(), 'prisma', 'migrations');
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    return names.length ? names[names.length - 1] : null;
  } catch {
    return null;
  }
}
