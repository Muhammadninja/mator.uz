import { Logger, type DynamicModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { BullBoardAuthMiddleware } from './bull-board-auth.middleware';
import { MONITORED_QUEUES, resolveBullBoardConfig } from './ops.config';

/**
 * Build the Bull Board imports for OpsModule, or none at all when it is
 * disabled.
 *
 * Lives in its own file (rather than inside ops.module.ts) so the mounting and
 * auth-wiring decisions can be unit-tested without importing OpsModule, which
 * pulls in AuthModule and its ESM-only transitive deps.
 *
 * Reads `process.env` (not ConfigService) because module METADATA must be
 * decided at class-decoration time, before DI exists — the same constraint the
 * queue module documents for its @Processor options. ConfigModule is loaded with
 * `isGlobal: true` from a `dotenv`-backed .env by the time Nest evaluates this,
 * so the values are present.
 */
export function bullBoardImports(): DynamicModule[] {
  const enabled =
    (process.env.BULL_BOARD_ENABLED ?? '').trim().toLowerCase() === 'true';
  if (!enabled) return [];

  const logger = new Logger('BullBoard');
  const route = (process.env.BULL_BOARD_ROUTE ?? '').trim() || '/admin/queues';

  if (!process.env.BULL_BOARD_USER || !process.env.BULL_BOARD_PASSWORD) {
    // Mount anyway — the middleware denies every request — but make the
    // misconfiguration loud at boot rather than at first access.
    logger.error(
      `Bull Board enabled at ${route} but BULL_BOARD_USER/BULL_BOARD_PASSWORD are unset. ` +
        'All access will be denied until they are configured.',
    );
  } else {
    logger.log(`Bull Board mounted at ${route} (Basic Auth required)`);
  }

  return [
    BullBoardModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const board = resolveBullBoardConfig(config);
        return {
          route: board.route,
          adapter: ExpressAdapter,
          // Applied by the board module BEFORE its router, on the board's routes
          // only — this is the auth gate.
          middleware: BullBoardAuthMiddleware,
          boardOptions: {
            uiConfig: { boardTitle: 'Mator Queues' },
          },
        };
      },
    }),
    // Expose every registered queue, derived from QUEUE_NAMES so a new queue is
    // picked up without editing this list.
    ...MONITORED_QUEUES.map((name) =>
      BullBoardModule.forFeature({
        name,
        adapter: BullMQAdapter,
        options: { readOnlyMode: readOnlyMode() },
      }),
    ),
  ];
}

/** Read-only unless mutations are explicitly allowed (see ops.config.ts). */
function readOnlyMode(): boolean {
  return (
    (process.env.BULL_BOARD_ALLOW_MUTATIONS ?? '').trim().toLowerCase() !==
    'true'
  );
}
