import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { AuthModule } from '../auth/auth.module';
import { AlertService } from './alert.service';
import { QueueMonitorService } from './queue-monitor.service';
import { QueueHealthController } from './queue-health.controller';
import { bullBoardImports } from './bull-board.imports';

/**
 * Phase 1 operations tooling: the Bull Board dashboard, queue health monitoring
 * and alerting.
 *
 * Strictly additive — nothing here participates in any business flow. The
 * monitor only READS job counts, the dashboard only renders them, and no
 * processor, payload, retry policy or workflow is touched by this module.
 *
 * Bull Board is mounted CONDITIONALLY (see bull-board.imports.ts): with
 * BULL_BOARD_ENABLED unset, no route exists at all. When enabled, every request
 * to it passes through BullBoardAuthMiddleware first, which fails closed if
 * credentials aren't configured.
 */
@Module({
  imports: [
    ConfigModule,
    // Re-registering the queues here is how this module obtains the SAME queue
    // instances via DI (@nestjs/bullmq resolves registrations by name against
    // the connection configured in QueueModule.forRootAsync). It does not create
    // a second set of queues, and it registers NO processors — this module never
    // consumes a job.
    BullModule.registerQueue(
      { name: QUEUE_NAMES.IMAGE_PROCESSING },
      { name: QUEUE_NAMES.SMS },
      { name: QUEUE_NAMES.NOTIFICATIONS },
      { name: QUEUE_NAMES.MAINTENANCE },
    ),
    // JwtAuthGuard's 'jwt' passport strategy for the admin queue-health endpoint.
    AuthModule,
    ...bullBoardImports(),
  ],
  controllers: [QueueHealthController],
  providers: [AlertService, QueueMonitorService],
  // Exported so a future module can raise its own alerts, or read queue samples,
  // through the same abstraction rather than inventing a second one.
  exports: [AlertService, QueueMonitorService],
})
export class OpsModule {}
