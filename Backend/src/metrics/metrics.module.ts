import { Global, Logger, Module, type Provider } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { boolEnv, normalizeMetricsPath } from './metrics.config';
import { createMetricsController } from './metrics.controller';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';
import { metricsProviders } from './metrics.providers';
import { MetricsService } from './metrics.service';
import { QueueMetricsCollector } from './queue-metrics.collector';

/**
 * Phase A observability: Prometheus metrics for the API, the Node process, the
 * BullMQ queues and a small set of Mator business events.
 *
 * Strictly additive. Nothing in this module participates in a business flow:
 * the collector only READS job counts, the interceptor only times requests that
 * would have run identically without it, and every recording path is wrapped so
 * a metrics failure can never surface to a caller (see MetricsService.safe).
 * No queue workflow, retry policy, payload, Redis key or DB schema is touched.
 *
 * `@Global` — like RedisModule and QueueModule — so MetricsService can be
 * injected by any instrumented service (DraftTelemetry, SmsService, the image
 * worker) WITHOUT those modules importing MetricsModule. That is what keeps the
 * dependency graph acyclic: metrics depends on the queue names (a constants
 * file, no cycle), and instrumented modules depend on nothing new.
 *
 * ── Disabling ──
 * With METRICS_ENABLED=false the controller is not registered (no route exists
 * at all), the HTTP interceptor is not bound, no default Node collectors are
 * attached, and the queue collector short-circuits. MetricsService itself is
 * still provided, so instrumented call sites need no null-checks — their
 * increments land in a registry nobody scrapes.
 */
@Global()
@Module({})
export class MetricsModule {
  static forRoot(): ReturnType<typeof buildMetricsModule> {
    return buildMetricsModule();
  }
}

function buildMetricsModule() {
  // Read at module-construction time, before DI exists — the same constraint
  // documented in metrics.controller.ts. ConfigModule({isGlobal:true}) has
  // already loaded .env via dotenv by now. Uses the SAME boolEnv helper as
  // resolveMetricsConfig so the route-mounting decision and the runtime config
  // can never disagree about what "enabled" means.
  const enabled = boolEnv(process.env.METRICS_ENABLED, true);
  const logger = new Logger('Metrics');

  const interceptor: Provider[] = enabled
    ? [{ provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor }]
    : [];

  if (enabled) {
    logger.log(
      `Prometheus metrics enabled at ${normalizeMetricsPath(process.env.METRICS_PATH)}`,
    );
  } else {
    logger.log('Prometheus metrics disabled (METRICS_ENABLED=false)');
  }

  return {
    module: MetricsModule,
    imports: [
      ConfigModule,
      // Re-registering the queues is how this module obtains the SAME queue
      // instances via DI — @nestjs/bullmq resolves registrations by name against
      // the connection configured in QueueModule.forRootAsync. It does NOT
      // create a second set of queues and registers NO processors: this module
      // never consumes a job. Identical to how OpsModule obtains them.
      BullModule.registerQueue(
        { name: QUEUE_NAMES.IMAGE_PROCESSING },
        { name: QUEUE_NAMES.SMS },
        { name: QUEUE_NAMES.NOTIFICATIONS },
        { name: QUEUE_NAMES.MAINTENANCE },
      ),
    ],
    // No controller at all when disabled — an operator who turns metrics off
    // gets no endpoint, not an endpoint that returns an empty body. When
    // enabled, the class is built against the RESOLVED path (see
    // createMetricsController) so METRICS_PATH actually moves the route.
    controllers: enabled
      ? [
          createMetricsController(
            normalizeMetricsPath(process.env.METRICS_PATH),
          ),
        ]
      : [],
    providers: [
      ...metricsProviders(),
      MetricsService,
      QueueMetricsCollector,
      ...interceptor,
    ],
    exports: [MetricsService],
  };
}
