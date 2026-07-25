import { Registry } from 'prom-client';
import { DEFAULT_METRICS_PREFIX, type MetricsConfig } from './metrics.config';
import { createAppMetrics } from './metrics.definitions';
import { MetricsService } from './metrics.service';
import { DraftMetric, DraftTelemetry } from '../telegram/draft-telemetry';
import { SmsService } from '../sms/sms.service';

/**
 * Verifies the INSTRUMENTED CALL SITES, not the metrics plumbing: that the
 * existing seams (DraftTelemetry.metric, SmsService.sendSms) now move the right
 * counters — and, just as importantly, that they behave exactly as they did
 * before when no MetricsService is supplied.
 */

function buildMetrics() {
  const config: MetricsConfig = {
    enabled: true,
    path: '/metrics',
    prefix: DEFAULT_METRICS_PREFIX,
    queueMetricsEnabled: true,
  };
  const registry = new Registry();
  const service = new MetricsService(
    createAppMetrics(registry, config),
    registry,
    config,
  );
  return { service, registry };
}

async function value(
  registry: Registry,
  name: string,
  labels: Record<string, string> = {},
): Promise<number | undefined> {
  const json = await registry.getMetricsAsJSON();
  const metric = json.find((m) => m.name === name);
  const values = (
    metric as unknown as
      | { values: { labels: Record<string, string>; value: number }[] }
      | undefined
  )?.values;
  return values?.find((v) =>
    Object.entries(labels).every(([k, val]) => String(v.labels[k]) === val),
  )?.value;
}

describe('DraftTelemetry → Prometheus', () => {
  it('increments the draft, product and expiry counters from existing call sites', async () => {
    const { service, registry } = buildMetrics();
    const telemetry = new DraftTelemetry(service);

    telemetry.metric(DraftMetric.DRAFT_CREATED, { draftId: 'd1', sellerId: 7 });
    telemetry.metric(DraftMetric.DRAFT_PUBLISHED, { draftId: 'd1' });
    telemetry.metric(DraftMetric.DRAFT_EXPIRED, { draftId: 'd2' });

    const p = DEFAULT_METRICS_PREFIX;
    expect(await value(registry, `${p}drafts_created_total`)).toBe(1);
    expect(await value(registry, `${p}products_published_total`)).toBe(1);
    expect(await value(registry, `${p}drafts_expired_total`)).toBe(1);
  });

  it('leaves image lifecycle points log-only (no counter defined for them)', async () => {
    const { service, registry } = buildMetrics();
    const telemetry = new DraftTelemetry(service);

    telemetry.metric(DraftMetric.IMAGE_STARTED, { imageId: 'i1' });
    telemetry.metric(DraftMetric.IMAGE_QUEUED, { imageId: 'i1' });

    // Image duration/outcome is observed by the worker, which knows the elapsed
    // time — a counter call site does not.
    const p = DEFAULT_METRICS_PREFIX;
    expect(await value(registry, `${p}drafts_created_total`)).toBe(0);
  });

  it('still works with no MetricsService — the pre-existing constructor shape', () => {
    // Every existing spec constructs DraftTelemetry with zero arguments.
    const telemetry = new DraftTelemetry();
    expect(() =>
      telemetry.metric(DraftMetric.DRAFT_CREATED, { draftId: 'd1' }),
    ).not.toThrow();
    expect(() =>
      telemetry.event('draft.created', { draftId: 'd1' }),
    ).not.toThrow();
  });

  it('never lets a metrics failure escape into the draft flow', () => {
    const { service } = buildMetrics();
    jest.spyOn(service, 'recordDraftCreated').mockImplementation(() => {
      throw new Error('metrics exploded');
    });
    const telemetry = new DraftTelemetry(service);

    // finalizePublishedDraft and friends call this inline after a DB write.
    expect(() => telemetry.metric(DraftMetric.DRAFT_CREATED)).not.toThrow();
  });
});

describe('SmsService → Prometheus', () => {
  const config = { get: () => undefined } as never;
  const prisma = { smsMessage: { create: jest.fn() } } as never;
  const resolver = { resolve: jest.fn().mockResolvedValue(null) } as never;

  /** Force the provider double in place of the env-selected one. */
  function withProvider(
    service: SmsService,
    send: jest.Mock,
    name = 'eskiz',
  ): void {
    (service as unknown as { provider: unknown }).provider = { name, send };
  }

  it('counts an accepted send by provider and template', async () => {
    const { service: metrics, registry } = buildMetrics();
    const sms = new SmsService(config, prisma, resolver, metrics);
    withProvider(sms, jest.fn().mockResolvedValue({ providerMessageId: 'x' }));

    await sms.sendSms('+998901234567', 'code 1234', 'otp');

    expect(
      await value(registry, `${DEFAULT_METRICS_PREFIX}sms_sent_total`, {
        provider: 'eskiz',
        template: 'otp',
      }),
    ).toBe(1);
  });

  it('counts a failed send AND re-throws unchanged so BullMQ still retries', async () => {
    const { service: metrics, registry } = buildMetrics();
    const sms = new SmsService(config, prisma, resolver, metrics);
    const failure = new Error('connect ETIMEDOUT');
    withProvider(sms, jest.fn().mockRejectedValue(failure));

    // The re-throw is what drives the retry policy — instrumentation must not
    // swallow it.
    await expect(sms.sendSms('+998901234567', 'hi', 'otp')).rejects.toBe(
      failure,
    );

    expect(
      await value(registry, `${DEFAULT_METRICS_PREFIX}sms_failed_total`, {
        provider: 'eskiz',
        template: 'otp',
        reason: 'timeout',
      }),
    ).toBe(1);
    // A failed send is not counted as sent.
    expect(
      await value(registry, `${DEFAULT_METRICS_PREFIX}sms_sent_total`),
    ).toBeUndefined();
  });

  it('does not record an accounting row for a failed send (unchanged behaviour)', async () => {
    const { service: metrics } = buildMetrics();
    const create = jest.fn();
    const sms = new SmsService(
      config,
      { smsMessage: { create } } as never,
      resolver,
      metrics,
    );
    withProvider(sms, jest.fn().mockRejectedValue(new Error('nope')));

    await expect(sms.sendSms('+998901234567', 'hi')).rejects.toThrow('nope');
    expect(create).not.toHaveBeenCalled();
  });

  it('works without a MetricsService — the pre-existing 3-arg constructor', async () => {
    const create = jest.fn().mockResolvedValue({});
    const sms = new SmsService(
      config,
      { smsMessage: { create } } as never,
      resolver,
    );
    withProvider(sms, jest.fn().mockResolvedValue({ providerMessageId: 'x' }));

    await expect(
      sms.sendSms('+998901234567', 'hi', 'otp'),
    ).resolves.toBeUndefined();
    // Accounting still happens exactly as before.
    expect(create).toHaveBeenCalledTimes(1);
  });
});
