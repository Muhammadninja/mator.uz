import {
  Controller,
  Get,
  Header,
  Res,
  UseGuards,
  type Type,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { MetricsAccessGuard } from './metrics-access.guard';
import { MetricsService } from './metrics.service';
import { QueueMetricsCollector } from './queue-metrics.collector';
import { SmsCostCollector } from './sms-cost.collector';
import { TelegramPollingCollector } from './telegram-polling.collector';

/**
 * The Prometheus scrape endpoint.
 *
 * ── Why the class is built by a factory rather than decorated directly ──
 * `@Controller(path)` is a class decorator: it is evaluated ONCE, when this
 * module is first imported, which would freeze the route at whatever
 * METRICS_PATH happened to hold at import time. That makes the path effectively
 * un-overridable — a problem for tests and for any process that configures the
 * path after first import. Building the class inside
 * `createMetricsController(path)` and applying the decorator there moves that
 * evaluation to MODULE CONSTRUCTION time, where the resolved config is
 * available. Same reason queue.constants.ts reads process.env for `@Processor`
 * options, but without the one-shot limitation.
 *
 * ACCESS: served only to a caller presenting METRICS_TOKEN or coming from an
 * allowed address (default: this machine); see MetricsAccessGuard. The registry
 * holds business counters (SMS spend, routing quota), so it is not public, and
 * Nginx should not proxy the path at all; see docs/P3_HARDENING.md.
 *
 * `@SkipThrottle()` because a 15s scrape must never be rate-limited into a gap
 * in the graphs (the global baseline is 100 req/min — see AppModule), and
 * `@ApiExcludeController()` keeps an operational endpoint out of the public
 * API docs.
 */
/**
 * How long one run of the pull collectors is reused. Prometheus scrapes every
 * 15 to 30 seconds; within this window a second scraper, a retry or anyone
 * hammering the route gets the gauges already in the registry, and neither
 * Redis nor the SMS accounting table is read again.
 */
export const COLLECT_TTL_MS = 15_000;

@ApiExcludeController()
@SkipThrottle()
@UseGuards(MetricsAccessGuard)
export class MetricsController {
  private collectedAt = 0;
  private collecting: Promise<void> | null = null;

  constructor(
    private readonly metrics: MetricsService,
    private readonly queues: QueueMetricsCollector,
    private readonly smsCost: SmsCostCollector,
    private readonly telegramPolling: TelegramPollingCollector,
  ) {}

  /**
   * Render the registry in Prometheus exposition format.
   *
   * The pull-based collectors run first so a scrape reflects Redis and the SMS
   * accounting table as of this request. Both `collect()` methods swallow their
   * own errors, so a Redis or Postgres outage degrades to stale gauges while
   * process/HTTP/business metrics still return 200. They run in PARALLEL: they
   * touch different backends, so total scrape latency is one round trip rather
   * than two.
   *
   * Writes through `@Res({ passthrough: false })`-style direct response because
   * the payload is text, not the app's `{ code, message }` JSON contract — the
   * global HttpExceptionFilter and ValidationPipe are irrelevant to it.
   */
  @Get()
  @Header('Cache-Control', 'no-store')
  async scrape(@Res() res: Response): Promise<void> {
    await this.collectOnce();
    // In-memory, synchronous, never throws (MetricsService.safe).
    this.telegramPolling.collect();
    const body = await this.metrics.scrape();
    res.setHeader('Content-Type', this.metrics.contentType);
    res.send(body);
  }

  /**
   * Run the collectors that touch Redis and PostgreSQL at most once per
   * {@link COLLECT_TTL_MS}. Concurrent scrapes share the run in flight.
   */
  private collectOnce(now = Date.now()): Promise<void> {
    if (this.collecting) return this.collecting;
    if (now - this.collectedAt < COLLECT_TTL_MS) return Promise.resolve();
    this.collecting = Promise.all([
      this.queues.collect(),
      this.smsCost.collect(),
    ])
      .then(() => {
        this.collectedAt = Date.now();
      })
      .finally(() => {
        this.collecting = null;
      });
    return this.collecting;
  }
}

/**
 * Produce the controller class bound to `path`.
 *
 * Applying `Controller(path)` to the class here (rather than as a decorator on
 * the declaration) is what makes the mount point configurable at runtime — see
 * the class docblock. The returned class is a fresh subclass per call, so two
 * differently-configured modules never fight over one piece of route metadata.
 */
export function createMetricsController(path: string): Type<MetricsController> {
  class ConfiguredMetricsController extends MetricsController {}
  Controller(path)(ConfiguredMetricsController);
  return ConfiguredMetricsController;
}
