import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { DEFAULT_JOB_OPTIONS, QUEUE_NAMES } from './queue.constants';
import { buildQueueConnection } from './queue.config';
import { QueueService } from './queue.service';
import {
  ImageProcessingProcessor,
  NotificationsProcessor,
  SmsProcessor,
} from './queue.processors';
import { DraftCleanupProcessor } from './draft-cleanup.processor';
import { ProductDraftModule } from '../telegram/product-draft.module';

/**
 * BullMQ infrastructure for the app.
 *
 * `@Global` — like RedisModule — so QueueService can be injected anywhere
 * without re-importing this module. This PR adds ONLY the plumbing: the queues
 * register, the workers start, and QueueService can enqueue placeholder jobs.
 * No existing request flow depends on any of it yet.
 *
 * Connection: `forRootAsync` reads the SAME REDIS_* env vars as the primary
 * Redis client via `buildQueueConnection` (ConfigService) — not a second Redis
 * configuration. `defaultJobOptions` applies the bounded retry + retention
 * policy (see queue.constants.ts) to every queue.
 *
 * Queues: registered by their typed names from QUEUE_NAMES — no string literals.
 * Each registered queue has a matching @Processor (worker) below, so nothing is
 * enqueued to a queue that has no consumer.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: buildQueueConnection(config),
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      }),
    }),
    BullModule.registerQueue(
      { name: QUEUE_NAMES.IMAGE_PROCESSING },
      { name: QUEUE_NAMES.SMS },
      { name: QUEUE_NAMES.NOTIFICATIONS },
      { name: QUEUE_NAMES.MAINTENANCE },
    ),
    // ProductDraftService (used by the draft-cleanup sweep). Imported rather than
    // re-declared so there is one instance shared with the Telegram side.
    ProductDraftModule,
  ],
  providers: [
    QueueService,
    ImageProcessingProcessor,
    SmsProcessor,
    NotificationsProcessor,
    DraftCleanupProcessor,
  ],
  exports: [QueueService],
})
export class QueueModule {}
