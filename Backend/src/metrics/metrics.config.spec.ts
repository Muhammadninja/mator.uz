import type { ConfigService } from '@nestjs/config';
import {
  DEFAULT_METRICS_PATH,
  DEFAULT_METRICS_PREFIX,
  normalizeMetricsPath,
  normalizeMetricsPrefix,
  resolveMetricsConfig,
} from './metrics.config';

function configWith(values: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('resolveMetricsConfig', () => {
  it('enables metrics at /metrics with no env set', () => {
    const config = resolveMetricsConfig(configWith());

    // Deliberately opt-OUT, not opt-in: an observability endpoint you have to
    // remember to switch on is one that's missing during the incident.
    expect(config.enabled).toBe(true);
    expect(config.path).toBe(DEFAULT_METRICS_PATH);
    expect(config.prefix).toBe(DEFAULT_METRICS_PREFIX);
    expect(config.queueMetricsEnabled).toBe(true);
    expect(config.smsCostMetricsEnabled).toBe(true);
  });

  it('disables only on an unambiguously false value', () => {
    for (const raw of ['false', 'FALSE', '0', 'no', 'off']) {
      expect(
        resolveMetricsConfig(configWith({ METRICS_ENABLED: raw })).enabled,
      ).toBe(false);
    }
  });

  it('stays enabled for affirmative or unrecognised values', () => {
    // The dangerous failure here is going silently blind, so anything that is
    // not clearly "off" keeps metrics on — including "1", which a strict
    // equals-"true" check would have read as disabled.
    for (const raw of ['true', 'TRUE', '1', 'yes', 'enabled']) {
      expect(
        resolveMetricsConfig(configWith({ METRICS_ENABLED: raw })).enabled,
      ).toBe(true);
    }
  });

  it('honours a custom path and queue toggle', () => {
    const config = resolveMetricsConfig(
      configWith({
        METRICS_PATH: '/internal/prom',
        METRICS_QUEUE_ENABLED: 'false',
      }),
    );
    expect(config.path).toBe('/internal/prom');
    expect(config.queueMetricsEnabled).toBe(false);
  });

  it('toggles the SMS cost query independently of the queue collector', () => {
    // The two collectors hit different backends (Postgres vs Redis), so an
    // operator taking the DB query off the scrape path must not lose queue
    // depths as a side effect.
    const config = resolveMetricsConfig(
      configWith({ METRICS_SMS_COST_ENABLED: 'false' }),
    );
    expect(config.smsCostMetricsEnabled).toBe(false);
    expect(config.queueMetricsEnabled).toBe(true);
  });
});

describe('normalizeMetricsPath', () => {
  it('adds a leading slash and strips trailing ones', () => {
    expect(normalizeMetricsPath('metrics')).toBe('/metrics');
    expect(normalizeMetricsPath('/metrics/')).toBe('/metrics');
    expect(normalizeMetricsPath('  /internal/prom  ')).toBe('/internal/prom');
  });

  it('falls back to the default for empty or slash-only values', () => {
    // Mounting the scrape endpoint at "/" would shadow the whole app.
    expect(normalizeMetricsPath(undefined)).toBe(DEFAULT_METRICS_PATH);
    expect(normalizeMetricsPath('   ')).toBe(DEFAULT_METRICS_PATH);
    expect(normalizeMetricsPath('/')).toBe(DEFAULT_METRICS_PATH);
  });
});

describe('normalizeMetricsPrefix', () => {
  it('accepts a valid Prometheus name prefix', () => {
    expect(normalizeMetricsPrefix('mator_')).toBe('mator_');
    expect(normalizeMetricsPrefix('app:')).toBe('app:');
  });

  it('rejects a prefix that would produce an invalid metric name', () => {
    // A bad prefix makes prom-client throw at registration, i.e. at boot.
    expect(normalizeMetricsPrefix('9bad-')).toBe(DEFAULT_METRICS_PREFIX);
    expect(normalizeMetricsPrefix('has space')).toBe(DEFAULT_METRICS_PREFIX);
    expect(normalizeMetricsPrefix('dash-es')).toBe(DEFAULT_METRICS_PREFIX);
    expect(normalizeMetricsPrefix('')).toBe(DEFAULT_METRICS_PREFIX);
  });
});
