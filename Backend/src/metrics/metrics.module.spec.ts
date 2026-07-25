import 'reflect-metadata';
import { Controller, Get, INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { Registry } from 'prom-client';
import request from 'supertest';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { MetricsModule } from './metrics.module';
import { MetricsService } from './metrics.service';
import { METRICS_REGISTRY } from './metrics.providers';
import { QueueMetricsCollector } from './queue-metrics.collector';

/**
 * Integration tests for the mounted endpoint.
 *
 * MetricsModule.forRoot() reads METRICS_ENABLED from process.env at MODULE
 * CONSTRUCTION time (the decorator-metadata constraint documented in
 * metrics.module.ts), so each case sets the env var, builds a fresh app, and
 * restores it afterwards. `jest.resetModules()` is deliberately NOT needed:
 * forRoot() is a function call, not module-level state.
 *
 * The BullMQ queues are stubbed at their DI tokens so no Redis connection is
 * opened — the same technique queue.module.di.spec.ts uses.
 */

/**
 * A parameterized route, so the cardinality guarantee can be asserted through
 * the REAL Express router rather than a hand-built ExecutionContext double.
 */
@Controller('products')
class ProductsProbeController {
  @Get(':id')
  findOne(): { ok: boolean } {
    return { ok: true };
  }
}

/** A fake BullMQ queue returning fixed counts. */
function stubQueue(counts: Record<string, number>, workers = 1) {
  return {
    getJobCounts: jest.fn().mockResolvedValue(counts),
    getWorkers: jest.fn().mockResolvedValue(new Array(workers).fill({})),
  };
}

async function buildApp(env: Record<string, string | undefined> = {}) {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const queues = {
    [QUEUE_NAMES.IMAGE_PROCESSING]: stubQueue(
      { waiting: 4, active: 2, delayed: 1, completed: 9, failed: 3, paused: 0 },
      5,
    ),
    [QUEUE_NAMES.SMS]: stubQueue({ waiting: 1, active: 0 }, 2),
    [QUEUE_NAMES.NOTIFICATIONS]: stubQueue({ waiting: 0 }, 1),
    [QUEUE_NAMES.MAINTENANCE]: stubQueue({ waiting: 0 }, 1),
  };

  const builder = Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      MetricsModule.forRoot(),
    ],
    controllers: [ProductsProbeController],
  });
  // Override every queue token so BullModule.registerQueue never dials Redis.
  for (const [name, queue] of Object.entries(queues)) {
    builder.overrideProvider(getQueueToken(name)).useValue(queue);
  }

  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  await app.init();

  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  return { app, moduleRef, queues, restore };
}

describe('/metrics endpoint', () => {
  let app: INestApplication;
  let restore: () => void;

  afterEach(async () => {
    await app?.close();
    restore?.();
  });

  it('is exposed at /metrics in the Prometheus text format', async () => {
    ({ app, restore } = await buildApp({
      METRICS_ENABLED: 'true',
      METRICS_PATH: undefined,
    }));

    const res = await request(app.getHttpServer()).get('/metrics').expect(200);

    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['content-type']).toContain('version=0.0.4');
    // A scrape must never be cached by an intermediary.
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain('# HELP');
    expect(res.text).toContain('# TYPE');
  });

  it('exports Node process metrics: CPU, memory, heap, event loop and uptime', async () => {
    ({ app, restore } = await buildApp({ METRICS_ENABLED: 'true' }));

    const { text } = await request(app.getHttpServer())
      .get('/metrics')
      .expect(200);

    expect(text).toContain('mator_process_cpu_seconds_total');
    expect(text).toContain('mator_process_resident_memory_bytes');
    expect(text).toContain('mator_nodejs_heap_size_used_bytes');
    expect(text).toContain('mator_nodejs_eventloop_lag_seconds');
    expect(text).toContain('mator_process_start_time_seconds');
  });

  it('exports BullMQ metrics for every registered queue', async () => {
    ({ app, restore } = await buildApp({ METRICS_ENABLED: 'true' }));

    const { text } = await request(app.getHttpServer())
      .get('/metrics')
      .expect(200);

    // Depths from the stubbed queues, per queue and per state.
    expect(text).toContain(
      'mator_bullmq_jobs{queue="image-processing",state="waiting"} 4',
    );
    expect(text).toContain(
      'mator_bullmq_jobs{queue="image-processing",state="active"} 2',
    );
    expect(text).toContain(
      'mator_bullmq_jobs{queue="image-processing",state="failed"} 3',
    );
    expect(text).toContain('mator_bullmq_workers{queue="image-processing"} 5');
    // Every queue in QUEUE_NAMES is represented, not just the busy one.
    for (const name of Object.values(QUEUE_NAMES)) {
      expect(text).toContain(`mator_bullmq_jobs{queue="${name}"`);
    }
  });

  it('records HTTP metrics for its own request via the global interceptor', async () => {
    ({ app, restore } = await buildApp({ METRICS_ENABLED: 'true' }));

    // First scrape generates the observation; the second one reports it.
    await request(app.getHttpServer()).get('/metrics').expect(200);
    const { text } = await request(app.getHttpServer())
      .get('/metrics')
      .expect(200);

    expect(text).toContain('mator_http_requests_total{');
    expect(text).toContain('method="GET"');
    expect(text).toContain('status_code="200"');
    expect(text).toContain('mator_http_request_duration_seconds_bucket');
  });

  it('collapses /products/123 and /products/456 into one /products/:id series', async () => {
    ({ app, restore } = await buildApp({ METRICS_ENABLED: 'true' }));

    // Two DIFFERENT concrete ids through the real Express router.
    await request(app.getHttpServer()).get('/products/123').expect(200);
    await request(app.getHttpServer()).get('/products/456').expect(200);

    const { text } = await request(app.getHttpServer())
      .get('/metrics')
      .expect(200);

    const productSeries = text
      .split('\n')
      .filter(
        (l) =>
          l.startsWith('mator_http_requests_total{') && l.includes('/products'),
      );

    // ONE series with a value of 2 — not two series of 1 each.
    expect(productSeries).toHaveLength(1);
    expect(productSeries[0]).toContain('route="/products/:id"');
    expect(productSeries[0].trim().endsWith(' 2')).toBe(true);
    // The concrete ids must appear nowhere in the exposition output.
    expect(text).not.toContain('/products/123');
    expect(text).not.toContain('/products/456');
  });

  it('honours a custom METRICS_PATH', async () => {
    ({ app, restore } = await buildApp({
      METRICS_ENABLED: 'true',
      METRICS_PATH: '/internal/prom',
    }));

    await request(app.getHttpServer()).get('/internal/prom').expect(200);
    // The default path must NOT also be mounted.
    await request(app.getHttpServer()).get('/metrics').expect(404);
  });

  it('registers each metric exactly once — a scrape has no duplicate series', async () => {
    ({ app, restore } = await buildApp({ METRICS_ENABLED: 'true' }));

    const { text } = await request(app.getHttpServer())
      .get('/metrics')
      .expect(200);

    // A double registration shows up as a repeated HELP line for one name.
    const helpLines = text
      .split('\n')
      .filter((l) => l.startsWith('# HELP '))
      .map((l) => l.split(' ')[2]);
    expect(helpLines.length).toBeGreaterThan(0);
    expect(new Set(helpLines).size).toBe(helpLines.length);
  });

  it('provides one registry instance and one MetricsService to the container', async () => {
    let moduleRef: Awaited<ReturnType<typeof buildApp>>['moduleRef'];
    ({ app, moduleRef, restore } = await buildApp({ METRICS_ENABLED: 'true' }));

    // Resolving twice must yield the SAME objects — the singleton guarantee is
    // what makes "registered once" structural rather than guard-flag enforced.
    const registryA = moduleRef.get<Registry>(METRICS_REGISTRY);
    const registryB = moduleRef.get<Registry>(METRICS_REGISTRY);
    expect(registryA).toBe(registryB);
    expect(moduleRef.get(MetricsService)).toBe(moduleRef.get(MetricsService));
  });

  it('refreshes queue gauges on each scrape rather than polling in the background', async () => {
    let queues: Awaited<ReturnType<typeof buildApp>>['queues'];
    ({ app, queues, restore } = await buildApp({ METRICS_ENABLED: 'true' }));

    const smsQueue = queues[QUEUE_NAMES.SMS];
    const callsAfterInit = smsQueue.getJobCounts.mock.calls.length;

    await request(app.getHttpServer()).get('/metrics').expect(200);
    const afterOne = smsQueue.getJobCounts.mock.calls.length;
    await request(app.getHttpServer()).get('/metrics').expect(200);
    const afterTwo = smsQueue.getJobCounts.mock.calls.length;

    // Nothing is read until a scrape arrives, then exactly one read per scrape.
    expect(callsAfterInit).toBe(0);
    expect(afterOne).toBe(1);
    expect(afterTwo).toBe(2);
  });
});

describe('/metrics with METRICS_ENABLED=false', () => {
  let app: INestApplication;
  let restore: () => void;

  afterEach(async () => {
    await app?.close();
    restore?.();
  });

  it('mounts no route at all', async () => {
    ({ app, restore } = await buildApp({ METRICS_ENABLED: 'false' }));

    // Not an empty 200 — the endpoint simply does not exist.
    await request(app.getHttpServer()).get('/metrics').expect(404);
  });

  it('still provides MetricsService so instrumented call sites need no null checks', async () => {
    let moduleRef: Awaited<ReturnType<typeof buildApp>>['moduleRef'];
    ({ app, moduleRef, restore } = await buildApp({
      METRICS_ENABLED: 'false',
    }));

    const service = moduleRef.get(MetricsService);
    expect(service.enabled).toBe(false);
    // Recording remains a safe no-op rather than a crash.
    expect(() => service.recordDraftCreated()).not.toThrow();
  });

  it('attaches no default Node collectors and does not read the queues', async () => {
    let moduleRef: Awaited<ReturnType<typeof buildApp>>['moduleRef'];
    let queues: Awaited<ReturnType<typeof buildApp>>['queues'];
    ({ app, moduleRef, queues, restore } = await buildApp({
      METRICS_ENABLED: 'false',
    }));

    const registry = moduleRef.get<Registry>(METRICS_REGISTRY);
    const text = await registry.metrics();
    expect(text).not.toContain('mator_process_cpu_seconds_total');

    await moduleRef.get(QueueMetricsCollector).collect();
    expect(queues[QUEUE_NAMES.SMS].getJobCounts).not.toHaveBeenCalled();
  });
});

describe('METRICS_QUEUE_ENABLED=false', () => {
  let app: INestApplication;
  let restore: () => void;

  afterEach(async () => {
    await app?.close();
    restore?.();
  });

  it('keeps /metrics up but stops sampling Redis', async () => {
    let queues: Awaited<ReturnType<typeof buildApp>>['queues'];
    ({ app, queues, restore } = await buildApp({
      METRICS_ENABLED: 'true',
      METRICS_QUEUE_ENABLED: 'false',
    }));

    const { text } = await request(app.getHttpServer())
      .get('/metrics')
      .expect(200);

    expect(text).toContain('mator_process_cpu_seconds_total');
    expect(queues[QUEUE_NAMES.SMS].getJobCounts).not.toHaveBeenCalled();
  });
});
