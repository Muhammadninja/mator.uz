import { Registry } from 'prom-client';
import type { MetricsConfig } from './metrics.config';
import { DEFAULT_METRICS_PREFIX } from './metrics.config';
import { createAppMetrics } from './metrics.definitions';
import { MetricsService } from './metrics.service';
import { SmsCostCollector } from './sms-cost.collector';
import type { PrismaService } from '../prisma/prisma.service';

function config(overrides: Partial<MetricsConfig> = {}): MetricsConfig {
  return {
    enabled: true,
    path: '/metrics',
    prefix: DEFAULT_METRICS_PREFIX,
    queueMetricsEnabled: true,
    smsCostMetricsEnabled: true,
    ...overrides,
  };
}

/**
 * A REAL MetricsService against a real registry, so assertions read the
 * exposition text Prometheus would actually scrape rather than trusting a mock
 * of our own code — the same choice metrics.service.spec.ts makes.
 */
function buildService(cfg = config()) {
  const registry = new Registry();
  const service = new MetricsService(
    createAppMetrics(registry, cfg),
    registry,
    cfg,
  );
  return { service, registry };
}

type GroupRow = { provider: string; _sum: { priceUzs: number | null } };

function prismaDouble(rows: GroupRow[] | Error) {
  const groupBy = jest.fn(() =>
    rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows),
  );
  return {
    double: { smsMessage: { groupBy } } as unknown as PrismaService,
    groupBy,
  };
}

describe('SmsCostCollector', () => {
  it('publishes a per-provider gauge and an overall total', async () => {
    const { service, registry } = buildService();
    const { double } = prismaDouble([
      { provider: 'mator', _sum: { priceUzs: 125_000 } },
      { provider: 'playmobile', _sum: { priceUzs: 84_200 } },
      { provider: 'eskiz', _sum: { priceUzs: 31_000 } },
    ]);

    await new SmsCostCollector(service, config(), double).collect();
    const text = await registry.metrics();

    expect(text).toContain(
      'mator_sms_provider_cost_uzs{provider="mator"} 125000',
    );
    expect(text).toContain(
      'mator_sms_provider_cost_uzs{provider="playmobile"} 84200',
    );
    expect(text).toContain(
      'mator_sms_provider_cost_uzs{provider="eskiz"} 31000',
    );
    // The stated contract: the total equals the sum of the providers.
    expect(text).toContain('mator_sms_cost_uzs 240200');
  });

  it('reads the accounting table with ONE aggregate query and no row fetch', async () => {
    const { service } = buildService();
    // Pulling rows and summing in JS would be O(table) per scrape and would
    // duplicate a calculation Postgres does for free. Fail loudly if any
    // row-returning API is reached for.
    const forbidden = {
      findMany: jest.fn(() => {
        throw new Error('findMany must not be used for cost metrics');
      }),
      aggregate: jest.fn(() => {
        throw new Error('a second aggregate pass would double the work');
      }),
    };
    const groupBy = jest
      .fn()
      .mockResolvedValue([{ provider: 'sayqal', _sum: { priceUzs: 10 } }]);
    const prisma = {
      smsMessage: { groupBy, ...forbidden },
    } as unknown as PrismaService;

    await new SmsCostCollector(service, config(), prisma).collect();

    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(groupBy).toHaveBeenCalledWith({
      by: ['provider'],
      _sum: { priceUzs: true },
    });
    expect(forbidden.findMany).not.toHaveBeenCalled();
    expect(forbidden.aggregate).not.toHaveBeenCalled();
  });

  it('is read-only: it never writes to the accounting table', async () => {
    const { service } = buildService();
    const { double, groupBy } = prismaDouble([
      { provider: 'mator', _sum: { priceUzs: 5 } },
    ]);

    await new SmsCostCollector(service, config(), double).collect();

    // Only groupBy exists on the double; any write would have thrown. Assert
    // explicitly that no mutating API was reached for — accounting logic is
    // owned by SmsService and this collector must not touch it.
    const m = (double as unknown as { smsMessage: Record<string, unknown> })
      .smsMessage;
    expect(m.create).toBeUndefined();
    expect(m.update).toBeUndefined();
    expect(m.updateMany).toBeUndefined();
    expect(m.delete).toBeUndefined();
    expect(groupBy).toHaveBeenCalledTimes(1);
  });

  it('counts a NULL price as zero rather than NaN', async () => {
    const { service, registry } = buildService();
    // priceUzs is nullable: the operator may not have resolved at send time.
    const { double } = prismaDouble([
      { provider: 'log', _sum: { priceUzs: null } },
      { provider: 'mator', _sum: { priceUzs: 700 } },
    ]);

    await new SmsCostCollector(service, config(), double).collect();
    const text = await registry.metrics();

    expect(text).toContain('mator_sms_provider_cost_uzs{provider="log"} 0');
    expect(text).toContain('mator_sms_cost_uzs 700');
    expect(text).not.toContain('NaN');
  });

  it('drops a provider that disappears from the table instead of flat-lining', async () => {
    const { service, registry } = buildService();
    const groupBy = jest
      .fn()
      .mockResolvedValueOnce([
        { provider: 'eskiz', _sum: { priceUzs: 400 } },
        { provider: 'mator', _sum: { priceUzs: 600 } },
      ])
      .mockResolvedValueOnce([{ provider: 'mator', _sum: { priceUzs: 600 } }]);
    const prisma = { smsMessage: { groupBy } } as unknown as PrismaService;
    const collector = new SmsCostCollector(service, config(), prisma);

    await collector.collect();
    await collector.collect();
    const text = await registry.metrics();

    // Retention pruned every eskiz row; reporting its last value forever would
    // overstate the total against a DB that no longer backs it.
    expect(text).not.toContain('provider="eskiz"');
    expect(text).toContain('mator_sms_cost_uzs 600');
  });

  it('never rejects when the database is unreachable', async () => {
    const { service, registry } = buildService();
    const { double } = prismaDouble(new Error('connection refused'));
    const collector = new SmsCostCollector(service, config(), double);

    // A Postgres hiccup during a scrape must still return every other metric.
    await expect(collector.collect()).resolves.toBeUndefined();
    // Nothing was published, so the gauge is absent rather than wrong.
    const text = await registry.metrics();
    expect(text).not.toContain('mator_sms_provider_cost_uzs{');
  });

  it('does nothing when metrics are disabled', async () => {
    const { service } = buildService();
    const { double, groupBy } = prismaDouble([]);

    await new SmsCostCollector(
      service,
      config({ enabled: false }),
      double,
    ).collect();

    expect(groupBy).not.toHaveBeenCalled();
  });

  it('does nothing when only the SMS cost query is disabled', async () => {
    const { service } = buildService();
    const { double, groupBy } = prismaDouble([]);

    await new SmsCostCollector(
      service,
      config({ smsCostMetricsEnabled: false }),
      double,
    ).collect();

    expect(groupBy).not.toHaveBeenCalled();
  });

  it('tolerates a context with no Prisma available at all', async () => {
    const { service } = buildService();
    const collector = new SmsCostCollector(service, config());
    await expect(collector.collect()).resolves.toBeUndefined();
  });
});
