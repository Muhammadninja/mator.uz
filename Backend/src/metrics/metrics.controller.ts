import { Controller, Get, Header, Res, type Type } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { MetricsService } from './metrics.service';
import { QueueMetricsCollector } from './queue-metrics.collector';

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
 * NOT AUTHENTICATED by design (per the Phase A brief): Prometheus scrapes it
 * over the private network and the edge protects it — see the operational notes
 * for the Nginx snippet. Nothing here exposes business data: only counter,
 * gauge and histogram values.
 *
 * `@SkipThrottle()` because a 15s scrape must never be rate-limited into a gap
 * in the graphs (the global baseline is 100 req/min — see AppModule), and
 * `@ApiExcludeController()` keeps an operational endpoint out of the public
 * API docs.
 */
@ApiExcludeController()
@SkipThrottle()
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly queues: QueueMetricsCollector,
  ) {}

  /**
   * Render the registry in Prometheus exposition format.
   *
   * Queue depths are refreshed first so a scrape reflects Redis as of this
   * request; `collect()` swallows its own errors, so a Redis outage degrades to
   * stale queue gauges while process/HTTP/business metrics still return 200.
   *
   * Writes through `@Res({ passthrough: false })`-style direct response because
   * the payload is text, not the app's `{ code, message }` JSON contract — the
   * global HttpExceptionFilter and ValidationPipe are irrelevant to it.
   */
  @Get()
  @Header('Cache-Control', 'no-store')
  async scrape(@Res() res: Response): Promise<void> {
    await this.queues.collect();
    const body = await this.metrics.scrape();
    res.setHeader('Content-Type', this.metrics.contentType);
    res.send(body);
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
