import { Registry } from 'prom-client';
import { DEFAULT_METRICS_PREFIX, type MetricsConfig } from './metrics.config';
import {
  createAppMetrics,
  registerDefaultMetrics,
} from './metrics.definitions';
import {
  MetricsService,
  classifyFailure,
  normalizeMethod,
} from './metrics.service';

/**
 * MetricsService against a REAL prom-client registry rather than a mock. The
 * thing worth testing is that a call site's increment actually lands as the
 * right series with the right labels in the exposition output — a mocked
 * Counter would assert only that we called our own code.
 */
function buildService(overrides: Partial<MetricsConfig> = {}) {
  const config: MetricsConfig = {
    enabled: true,
    path: '/metrics',
    prefix: DEFAULT_METRICS_PREFIX,
    queueMetricsEnabled: true,
    ...overrides,
  };
  const registry = new Registry();
  const metrics = createAppMetrics(registry, config);
  return { service: new MetricsService(metrics, registry, config), registry };
}

/** Read one sample's value out of the registry by metric name + labels. */
async function sampleValue(
  registry: Registry,
  name: string,
  labels: Record<string, string> = {},
): Promise<number | undefined> {
  const json = await registry.getMetricsAsJSON();
  const found = json.find((m) => m.name === name);
  if (!found) return undefined;
  const values = (
    found as { values: { labels: Record<string, string>; value: number }[] }
  ).values;
  const match = values.find((v) =>
    Object.entries(labels).every(([k, val]) => String(v.labels[k]) === val),
  );
  return match?.value;
}

describe('MetricsService business counters', () => {
  it('increments drafts created, products published and drafts expired', async () => {
    const { service, registry } = buildService();

    service.recordDraftCreated();
    service.recordDraftCreated();
    service.recordProductPublished();
    service.recordDraftExpired();

    expect(
      await sampleValue(
        registry,
        `${DEFAULT_METRICS_PREFIX}drafts_created_total`,
      ),
    ).toBe(2);
    expect(
      await sampleValue(
        registry,
        `${DEFAULT_METRICS_PREFIX}products_published_total`,
      ),
    ).toBe(1);
    expect(
      await sampleValue(
        registry,
        `${DEFAULT_METRICS_PREFIX}drafts_expired_total`,
      ),
    ).toBe(1);
  });

  it('counts SMS sent and failed separately, labelled by provider and template', async () => {
    const { service, registry } = buildService();

    service.recordSmsSent('eskiz', 'otp');
    service.recordSmsSent('eskiz', 'otp');
    service.recordSmsFailed('eskiz', 'otp', new Error('connect ETIMEDOUT'));

    expect(
      await sampleValue(registry, `${DEFAULT_METRICS_PREFIX}sms_sent_total`, {
        provider: 'eskiz',
        template: 'otp',
      }),
    ).toBe(2);
    // The failure is classified, not recorded verbatim — see classifyFailure.
    expect(
      await sampleValue(registry, `${DEFAULT_METRICS_PREFIX}sms_failed_total`, {
        provider: 'eskiz',
        template: 'otp',
        reason: 'timeout',
      }),
    ).toBe(1);
  });

  it('collapses a missing template to a fixed sentinel rather than an empty label', async () => {
    const { service, registry } = buildService();
    service.recordSmsSent('log', null);

    expect(
      await sampleValue(registry, `${DEFAULT_METRICS_PREFIX}sms_sent_total`, {
        provider: 'log',
        template: 'unknown',
      }),
    ).toBe(1);
  });
});

describe('image processing histogram buckets', () => {
  it('extends past 120s so a slow FLUX run is still measurable, not lumped into +Inf', async () => {
    const { service, registry } = buildService();
    const name = `${DEFAULT_METRICS_PREFIX}image_processing_duration_seconds`;

    // A realistic slow pipeline: FLUX plus two Cloudinary round trips.
    service.observeImageProcessing('success', 150);

    const text = await registry.metrics();
    // With a 120s top bucket this observation would only be visible in +Inf,
    // making p95 uninterpolatable exactly when it matters.
    expect(text).toContain(`${name}_bucket{le="180",result="success"} 1`);
    expect(text).toContain(`${name}_bucket{le="300",result="success"} 1`);
    expect(text).toContain(`${name}_bucket{le="120",result="success"} 0`);
  });

  it('keeps dense resolution in the tens-of-seconds range where FLUX degradation shows', async () => {
    const { service, registry } = buildService();
    const name = `${DEFAULT_METRICS_PREFIX}image_processing_duration_seconds`;

    service.observeImageProcessing('success', 40);

    const text = await registry.metrics();
    // 45 and 90 exist as distinct buckets — a jump from 30 straight to 60 would
    // hide a shift from "healthy 30s" to "degraded 50s".
    expect(text).toContain(`${name}_bucket{le="45",result="success"} 1`);
    expect(text).toContain(`${name}_bucket{le="30",result="success"} 0`);
    expect(text).toContain(`${name}_bucket{le="90",result="success"} 1`);
  });
});

describe('MetricsService histograms', () => {
  it('observes image processing duration into buckets with a matching count', async () => {
    const { service, registry } = buildService();

    service.observeImageProcessing('success', 3);
    service.observeImageProcessing('success', 12);

    const text = await registry.metrics();
    const name = `${DEFAULT_METRICS_PREFIX}image_processing_duration_seconds`;

    // Two observations totalling 15s, and the 3s one lands in the le=5 bucket
    // while the 12s one does not.
    expect(text).toContain(`${name}_count{result="success"} 2`);
    expect(text).toContain(`${name}_sum{result="success"} 15`);
    expect(text).toContain(`${name}_bucket{le="5",result="success"} 1`);
    expect(text).toContain(`${name}_bucket{le="20",result="success"} 2`);
  });

  it('observes HTTP request duration and increments the request counter together', async () => {
    const { service, registry } = buildService();

    service.startHttpRequest('GET');
    service.observeHttpRequest('GET', '/v1/orders/:id', 200, 0.042);

    const labels = {
      method: 'GET',
      route: '/v1/orders/:id',
      status_code: '200',
    };
    expect(
      await sampleValue(
        registry,
        `${DEFAULT_METRICS_PREFIX}http_requests_total`,
        labels,
      ),
    ).toBe(1);

    const text = await registry.metrics();
    expect(text).toContain(
      `${DEFAULT_METRICS_PREFIX}http_request_duration_seconds_count{method="GET",route="/v1/orders/:id",status_code="200"} 1`,
    );
    // The in-flight gauge went up and back down — it must not leak.
    expect(
      await sampleValue(
        registry,
        `${DEFAULT_METRICS_PREFIX}http_requests_in_flight`,
        { method: 'GET' },
      ),
    ).toBe(0);
  });

  it('records a job duration on the queue histogram', async () => {
    const { service, registry } = buildService();

    service.observeJob('sms', 'success', 1.5);
    service.observeJob('sms', 'failure');

    const text = await registry.metrics();
    expect(text).toContain(
      `${DEFAULT_METRICS_PREFIX}bullmq_job_duration_seconds_sum{queue="sms",result="success"} 1.5`,
    );
    // A job with no usable timestamps still counts, it just isn't timed.
    expect(
      await sampleValue(
        registry,
        `${DEFAULT_METRICS_PREFIX}bullmq_jobs_processed_total`,
        { queue: 'sms', result: 'failure' },
      ),
    ).toBe(1);
    expect(text).not.toContain(
      `${DEFAULT_METRICS_PREFIX}bullmq_job_duration_seconds_count{queue="sms",result="failure"}`,
    );
  });
});

describe('MetricsService queue gauges', () => {
  it('exports BullMQ depths per queue and state', async () => {
    const { service, registry } = buildService();

    service.setQueueDepths('image-processing', {
      waiting: 4,
      active: 2,
      delayed: 1,
      completed: 100,
      failed: 3,
    });
    service.setQueueWorkers('image-processing', 5);

    const name = `${DEFAULT_METRICS_PREFIX}bullmq_jobs`;
    expect(
      await sampleValue(registry, name, {
        queue: 'image-processing',
        state: 'waiting',
      }),
    ).toBe(4);
    expect(
      await sampleValue(registry, name, {
        queue: 'image-processing',
        state: 'active',
      }),
    ).toBe(2);
    expect(
      await sampleValue(registry, name, {
        queue: 'image-processing',
        state: 'delayed',
      }),
    ).toBe(1);
    expect(
      await sampleValue(registry, name, {
        queue: 'image-processing',
        state: 'failed',
      }),
    ).toBe(3);
    expect(
      await sampleValue(registry, `${DEFAULT_METRICS_PREFIX}bullmq_workers`, {
        queue: 'image-processing',
      }),
    ).toBe(5);
  });

  it('is a gauge — a later sample replaces the earlier value', async () => {
    const { service, registry } = buildService();

    service.setQueueDepths('sms', { waiting: 10 });
    service.setQueueDepths('sms', { waiting: 2 });

    // Depths must reflect Redis right now, not accumulate across scrapes.
    expect(
      await sampleValue(registry, `${DEFAULT_METRICS_PREFIX}bullmq_jobs`, {
        queue: 'sms',
        state: 'waiting',
      }),
    ).toBe(2);
  });

  it('ignores a non-numeric count instead of corrupting the gauge', async () => {
    const { service, registry } = buildService();
    service.setQueueDepths('sms', {
      waiting: 3,
      active: NaN,
    });

    expect(
      await sampleValue(registry, `${DEFAULT_METRICS_PREFIX}bullmq_jobs`, {
        queue: 'sms',
        state: 'waiting',
      }),
    ).toBe(3);
    expect(
      await sampleValue(registry, `${DEFAULT_METRICS_PREFIX}bullmq_jobs`, {
        queue: 'sms',
        state: 'active',
      }),
    ).toBeUndefined();
  });
});

describe('MetricsService resilience', () => {
  it('never throws out of a recording call, even when the metric does', () => {
    const { service } = buildService();
    // Simulate a prom-client failure inside a business path (rule 1 in the
    // class docblock): the call site must not see it.
    const broken = service as unknown as {
      metrics: { draftsCreatedTotal: { inc: () => void } };
    };
    broken.metrics.draftsCreatedTotal.inc = () => {
      throw new Error('registry exploded');
    };

    expect(() => service.recordDraftCreated()).not.toThrow();
  });
});

describe('default process metrics', () => {
  it('registers Node/process collectors including CPU, memory, heap and event loop', async () => {
    const registry = new Registry();
    registerDefaultMetrics(registry, {
      enabled: true,
      path: '/metrics',
      prefix: DEFAULT_METRICS_PREFIX,
      queueMetricsEnabled: true,
    });

    const text = await registry.metrics();
    const p = DEFAULT_METRICS_PREFIX;
    expect(text).toContain(`${p}process_cpu_seconds_total`);
    expect(text).toContain(`${p}process_resident_memory_bytes`);
    expect(text).toContain(`${p}nodejs_heap_size_used_bytes`);
    expect(text).toContain(`${p}nodejs_eventloop_lag_seconds`);
    // Uptime is derived from process start time, which prom-client exports.
    expect(text).toContain(`${p}process_start_time_seconds`);
  });
});

describe('label normalization', () => {
  it('keeps HTTP method cardinality bounded to known verbs', () => {
    expect(normalizeMethod('get')).toBe('GET');
    expect(normalizeMethod('POST')).toBe('POST');
    // A garbage verb from a scanner must not mint a new series per request.
    expect(normalizeMethod('BREW')).toBe('unknown');
    expect(normalizeMethod(undefined)).toBe('unknown');
  });

  it('never lets a raw error message reach the reason label', async () => {
    const { service, registry } = buildService();

    // Provider errors typically embed IDs, hosts and phone fragments. If any of
    // that reached the label we would mint a series per failure.
    service.recordSmsFailed(
      'eskiz',
      'otp',
      new Error(
        'send to +998901234567 failed: txn 8f21c0 rejected at 10.2.3.4',
      ),
    );
    service.recordSmsFailed(
      'eskiz',
      'otp',
      new Error(
        'send to +998907654321 failed: txn 9a02de rejected at 10.2.3.9',
      ),
    );

    const text = await registry.metrics();
    expect(text).not.toContain('998901234567');
    expect(text).not.toContain('8f21c0');
    // Both distinct messages collapse to ONE series.
    const series = text
      .split('\n')
      .filter((l) =>
        l.startsWith(`${DEFAULT_METRICS_PREFIX}sms_failed_total{`),
      );
    expect(series).toHaveLength(1);
    expect(
      await sampleValue(registry, `${DEFAULT_METRICS_PREFIX}sms_failed_total`, {
        reason: 'other',
      }),
    ).toBe(2);
  });

  it('bounds the reason label to a known closed set', () => {
    const allowed = new Set([
      'timeout',
      'network',
      'auth',
      'rate_limited',
      'invalid_request',
      'other',
      'unknown',
    ]);
    const samples: unknown[] = [
      new Error('connect ETIMEDOUT'),
      new Error('socket hang up'),
      new Error('403 Forbidden'),
      new Error('429 rate limit'),
      new Error('validation failed'),
      new Error('totally novel failure mode 12345'),
      'a bare string',
      undefined,
      null,
      { weird: true },
    ];

    for (const sample of samples) {
      expect(allowed.has(classifyFailure(sample))).toBe(true);
    }
  });

  it('maps arbitrary errors onto a small closed set of reasons', () => {
    expect(classifyFailure(new Error('connect ETIMEDOUT 1.2.3.4'))).toBe(
      'timeout',
    );
    expect(classifyFailure(new Error('getaddrinfo ENOTFOUND api.x'))).toBe(
      'network',
    );
    expect(classifyFailure(new Error('401 Unauthorized'))).toBe('auth');
    expect(classifyFailure(new Error('Rate limit exceeded'))).toBe(
      'rate_limited',
    );
    expect(classifyFailure(new Error('invalid phone number'))).toBe(
      'invalid_request',
    );
    expect(classifyFailure(new Error('kaboom'))).toBe('other');
    expect(classifyFailure(undefined)).toBe('unknown');
  });
});
