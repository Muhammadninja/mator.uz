import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiExcludeController } from '@nestjs/swagger';
import { BlueprintTokenGuard } from './blueprint-token.guard';
import { mintTicket } from './blueprint-auth';
import { parseSchema } from '../../scripts/parse-schema';
import type { BlueprintGraph } from '../../scripts/parse-schema';

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
  private graphCache: BlueprintGraph | null = null;

  /** The node/edge/module graph the frontend renders. */
  @Get('graph')
  getGraph(): BlueprintGraph {
    if (!this.graphCache) {
      const schemaPath = join(process.cwd(), 'prisma', 'schema.prisma');
      const graph = parseSchema(readFileSync(schemaPath, 'utf8'));
      graph.generatedAt = new Date().toISOString();
      this.graphCache = graph;
    }
    return this.graphCache;
  }

  /**
   * Mint a short-lived WS ticket. The admin server calls this (with the
   * operator token), then hands the opaque ticket to the browser, which uses it
   * in the `/blueprint?ticket=…` WebSocket URL. See {@link mintTicket}.
   */
  @Post('ticket')
  getTicket(): { ticket: string; expiresAt: number } {
    return mintTicket();
  }
}
