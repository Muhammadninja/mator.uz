import { ConfigService } from '@nestjs/config';
import type { RedisService } from '../redis/redis.service';
import {
  AlertSilenceService,
  GLOBAL_SILENCE_SCOPE,
  parseSilenceDuration,
  silenceKey,
} from './alert-silence.service';
import { AlertSeverity, type AlertPayload } from './alerting.types';

/**
 * Suppression is the feature that decides whether the channel stays trusted.
 * Too little and every deploy produces a burst of false positives; too much and
 * a real outage is hidden behind a forgotten silence. These tests pin both
 * edges, especially the CRITICAL bypass.
 */

function fakeRedis() {
  const store = new Map<string, unknown>();

  const redis = {
    get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    setEx: jest.fn((key: string, _ttl: number, value: unknown) => {
      store.set(key, value);
      return Promise.resolve('OK' as const);
    }),
    del: jest.fn((key: string) => Promise.resolve(store.delete(key) ? 1 : 0)),
    scan: jest.fn((pattern: string) => {
      const prefix = pattern.replace(/\*$/, '');
      return Promise.resolve(
        [...store.keys()].filter((key) => key.startsWith(prefix)),
      );
    }),
  };

  return { redis: redis as unknown as RedisService, store };
}

function buildService(env: Record<string, string> = {}) {
  const { redis, store } = fakeRedis();
  const config = { get: (key: string) => env[key] } as unknown as ConfigService;
  return { silence: new AlertSilenceService(redis, config), store, redis };
}

function payload(over: Partial<AlertPayload> = {}): AlertPayload {
  return {
    rule: 'queue_backlog',
    severity: AlertSeverity.ERROR,
    labels: { queue: 'sms' },
    values: { waiting: 150 },
    title: 'Sms Queue Backlog',
    summary: 'sms queue backlog',
    ...over,
  };
}

describe('AlertSilenceService', () => {
  describe('startup grace period', () => {
    it('suppresses non-critical alerts right after boot', async () => {
      // A restart temporarily breaks every rule's premise: queues have not
      // drained and the rate windows have no baseline.
      const { silence } = buildService({ ALERT_STARTUP_GRACE_SEC: '120' });

      const reason = await silence.suppressionFor(payload());

      expect(reason?.kind).toBe('startup_grace');
    });

    it('never suppresses a CRITICAL alert', async () => {
      // If Postgres is unreachable 5s after a deploy, that IS the news —
      // silencing it is how a bad release reaches production unnoticed.
      const { silence } = buildService({ ALERT_STARTUP_GRACE_SEC: '120' });

      const reason = await silence.suppressionFor(
        payload({ severity: AlertSeverity.CRITICAL }),
      );

      expect(reason).toBeNull();
    });

    it('stops suppressing once the window has elapsed', async () => {
      const { silence } = buildService({ ALERT_STARTUP_GRACE_SEC: '120' });

      const later = Date.now() + 121 * 1000;

      expect(await silence.suppressionFor(payload(), later)).toBeNull();
      expect(silence.inStartupGrace(later)).toBe(false);
    });

    it('can be disabled with ALERT_STARTUP_GRACE_SEC=0', async () => {
      const { silence } = buildService({ ALERT_STARTUP_GRACE_SEC: '0' });

      expect(await silence.suppressionFor(payload())).toBeNull();
    });
  });

  describe('maintenance mode', () => {
    it('suppresses non-critical alerts while MAINTENANCE=true', async () => {
      const { silence } = buildService({
        MAINTENANCE: 'true',
        ALERT_STARTUP_GRACE_SEC: '0',
      });

      expect((await silence.suppressionFor(payload()))?.kind).toBe(
        'maintenance',
      );
    });

    it('still lets CRITICAL through', async () => {
      const { silence } = buildService({
        MAINTENANCE: 'true',
        ALERT_STARTUP_GRACE_SEC: '0',
      });

      expect(
        await silence.suppressionFor(
          payload({ severity: AlertSeverity.CRITICAL }),
        ),
      ).toBeNull();
    });

    it('is off unless explicitly enabled', async () => {
      const { silence } = buildService({ ALERT_STARTUP_GRACE_SEC: '0' });

      expect(await silence.suppressionFor(payload())).toBeNull();
    });
  });

  describe('runtime silences', () => {
    const noGrace = { ALERT_STARTUP_GRACE_SEC: '0' };

    it('suppresses everything under the global scope', async () => {
      const { silence } = buildService(noGrace);

      await silence.silence(GLOBAL_SILENCE_SCOPE, 30, 'akmal', 'deploying');

      const reason = await silence.suppressionFor(payload());
      expect(reason?.kind).toBe('silence');
    });

    it('can silence one noisy rule without going blind to the rest', async () => {
      const { silence } = buildService(noGrace);

      await silence.silence('image_processing_latency', 30);

      expect(
        await silence.suppressionFor(payload({ rule: 'queue_backlog' })),
      ).toBeNull();
      expect(
        (
          await silence.suppressionFor(
            payload({ rule: 'image_processing_latency' }),
          )
        )?.kind,
      ).toBe('silence');
    });

    it('expires on its own so a forgotten silence cannot last forever', async () => {
      const { silence } = buildService(noGrace);

      await silence.silence(GLOBAL_SILENCE_SCOPE, 30);

      const afterExpiry = Date.now() + 31 * 60 * 1000;
      expect(await silence.suppressionFor(payload(), afterExpiry)).toBeNull();
    });

    it('clamps a silence to ALERT_MAX_SILENCE_MIN', async () => {
      // A typo ("silence 6000") must not mute alerting for four days.
      const { silence } = buildService({
        ...noGrace,
        ALERT_MAX_SILENCE_MIN: '60',
      });

      const record = await silence.silence(GLOBAL_SILENCE_SCOPE, 6000);

      expect(record.expiresAt - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000);
    });

    it('can be lifted early', async () => {
      const { silence } = buildService(noGrace);
      await silence.silence(GLOBAL_SILENCE_SCOPE, 30);

      expect(await silence.unsilence(GLOBAL_SILENCE_SCOPE)).toBe(true);
      expect(await silence.suppressionFor(payload())).toBeNull();
    });

    it('reports lifting a silence that was not set', async () => {
      const { silence } = buildService(noGrace);

      expect(await silence.unsilence(GLOBAL_SILENCE_SCOPE)).toBe(false);
    });

    it('never silences CRITICAL', async () => {
      const { silence } = buildService(noGrace);
      await silence.silence(GLOBAL_SILENCE_SCOPE, 30);

      expect(
        await silence.suppressionFor(
          payload({ severity: AlertSeverity.CRITICAL }),
        ),
      ).toBeNull();
    });

    it('ignores a malformed silence row rather than trusting it', async () => {
      // A corrupt value must never be able to mute alerting.
      const { silence, store } = buildService(noGrace);
      store.set(silenceKey(GLOBAL_SILENCE_SCOPE), 'not-an-object');

      expect(await silence.suppressionFor(payload())).toBeNull();
    });

    it('lists the silences currently in force', async () => {
      const { silence } = buildService(noGrace);
      await silence.silence(GLOBAL_SILENCE_SCOPE, 30, 'akmal', 'deploy');

      const active = await silence.activeSilences();

      expect(active.get(GLOBAL_SILENCE_SCOPE)).toMatchObject({
        requestedBy: 'akmal',
        reason: 'deploy',
      });
    });
  });

  it('describes why an alert was held back', () => {
    const { silence } = buildService();

    expect(silence.describe({ kind: 'maintenance' })).toBe('maintenance mode');
    expect(
      silence.describe({ kind: 'startup_grace', remainingMs: 90_000 }),
    ).toContain('1m');
  });
});

describe('parseSilenceDuration', () => {
  it('accepts bare minutes and explicit units', () => {
    expect(parseSilenceDuration('30')).toBe(30);
    expect(parseSilenceDuration('30m')).toBe(30);
    expect(parseSilenceDuration('2h')).toBe(120);
    expect(parseSilenceDuration(' 45 min ')).toBe(45);
  });

  it('rejects anything unparseable rather than guessing a default', () => {
    // Silently silencing for a duration the operator did not intend is worse
    // than refusing the command.
    expect(parseSilenceDuration('soon')).toBeNull();
    expect(parseSilenceDuration('0')).toBeNull();
    expect(parseSilenceDuration('-5m')).toBeNull();
    expect(parseSilenceDuration('')).toBeNull();
  });
});
