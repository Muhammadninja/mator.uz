import { ConfigService } from '@nestjs/config';
import { AlertService } from '../ops/alert.service';
import { ALERT_TYPES } from '../ops/alert.types';
import type { AlertNotifierService } from './alert-notifier.service';
import {
  ALERT_STATE,
  AlertSeverity,
  alertFingerprint,
  type AlertNotification,
  type AlertSource,
} from './alerting.types';
import {
  OpsAlertBridge,
  mapOpsSeverity,
  opsAlertTitle,
} from './ops-alert.bridge';

/**
 * The bridge is what stops this module from duplicating the queue-monitor's
 * detection logic. These tests assert it registers on the EXISTING AlertService
 * and forwards faithfully, rather than reimplementing anything.
 */

function configWith(env: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

const SOURCE: AlertSource = {
  version: '2.8.14',
  commit: '81e6fd3',
  host: 'backend-02',
  instance: 'worker-3',
  pid: 4242,
};

function stubNotifier() {
  const sent: AlertNotification[] = [];
  const notifier = {
    notify: jest.fn((n: AlertNotification) => {
      sent.push(n);
      return Promise.resolve();
    }),
  } as unknown as jest.Mocked<AlertNotifierService>;
  return { notifier, sent };
}

function buildBridge(env: Record<string, string> = {}) {
  const ops = new AlertService(configWith(env));
  const { notifier, sent } = stubNotifier();
  const bridge = new OpsAlertBridge(ops, notifier, SOURCE, configWith(env));
  return { ops, bridge, notifier, sent };
}

describe('OpsAlertBridge', () => {
  it('registers itself as a channel on the existing AlertService', async () => {
    const { ops, bridge, sent } = buildBridge();
    bridge.onModuleInit();

    // Raising through the EXISTING service now reaches the channels — detection
    // logic untouched, which was the documented extension point.
    await ops.raise({
      type: ALERT_TYPES.NO_ACTIVE_WORKERS,
      severity: 'critical',
      queue: 'sms',
      message: 'No workers attached but 12 job(s) pending',
      context: { waiting: 12, active: 0, workers: 0 },
      firedAt: new Date(1_700_000_000_000),
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      state: ALERT_STATE.ACTIVE,
      rule: ALERT_TYPES.NO_ACTIVE_WORKERS,
      severity: AlertSeverity.CRITICAL,
      title: 'Sms — No Active Workers',
      firedAt: 1_700_000_000_000,
    });
  });

  it('produces the same labelled dedupe-key shape as a native rule', async () => {
    // So ops alerts group, filter and route identically downstream.
    const { bridge, sent } = buildBridge({
      ALERT_ENVIRONMENT_LABEL: 'Production',
    });

    await bridge.deliver({
      type: ALERT_TYPES.FAILED_JOBS,
      severity: 'warning',
      queue: 'sms',
      message: '30 failed jobs',
      context: {},
      firedAt: new Date(),
    });

    expect(sent[0].dedupeKey).toBe(
      'failed_jobs{environment="production",queue="sms"}',
    );
    expect(sent[0].labels).toEqual({ queue: 'sms', environment: 'production' });
    // A queue alert is quotable in chat exactly like a native one.
    expect(sent[0].fingerprint).toBe(alertFingerprint(sent[0].dedupeKey));
    expect(sent[0].source).toEqual(SOURCE);
  });

  it('carries the structured context through as alert values', async () => {
    const { bridge, sent } = buildBridge();

    await bridge.deliver({
      type: ALERT_TYPES.WAITING_GROWING,
      severity: 'warning',
      queue: 'image-processing',
      message: 'Waiting jobs growing for 3 consecutive samples (now 140)',
      context: { waiting: 140, growthStreak: 3, threshold: 100 },
      firedAt: new Date(),
    });

    expect(sent[0].values).toMatchObject({
      waiting: 140,
      growthStreak: 3,
      threshold: 100,
    });
  });

  it('skips non-primitive context values that would render as [object Object]', async () => {
    const { bridge, sent } = buildBridge();

    await bridge.deliver({
      type: ALERT_TYPES.MONITOR_ERROR,
      severity: 'warning',
      queue: 'sms',
      message: 'Failed to sample queue',
      context: { nested: { a: 1 }, waiting: 5 },
      firedAt: new Date(),
    });

    expect(sent[0].values.waiting).toBe(5);
    expect(Object.keys(sent[0].values)).not.toContain('nested');
  });

  it('honours the ops cooldown rather than adding a second dedupe layer', async () => {
    const { ops, bridge, sent } = buildBridge({
      QUEUE_ALERT_COOLDOWN_MIN: '15',
    });
    bridge.onModuleInit();

    const alert = {
      type: ALERT_TYPES.FAILED_JOBS,
      severity: 'warning' as const,
      queue: 'sms',
      message: '30 failed jobs',
      context: { failed: 30 },
      firedAt: new Date(),
    };

    await ops.raise(alert);
    await ops.raise(alert);
    await ops.raise(alert);

    // AlertService suppressed the repeats before `deliver` was ever called.
    expect(sent).toHaveLength(1);
  });
});

describe('mapOpsSeverity', () => {
  it('maps the ops two-level scale onto the four-level one', () => {
    // `warning` → ERROR, not WARNING: an ops alert already survived its own
    // detection thresholds, so by the time it is raised it is confirmed.
    expect(mapOpsSeverity('warning')).toBe(AlertSeverity.ERROR);
    expect(mapOpsSeverity('critical')).toBe(AlertSeverity.CRITICAL);
  });
});

describe('opsAlertTitle', () => {
  it('title-cases the queue and the alert type', () => {
    expect(
      opsAlertTitle({
        type: ALERT_TYPES.FAILED_JOBS,
        queue: 'image-processing',
      }),
    ).toBe('Image Processing — Failed Jobs');
  });
});
