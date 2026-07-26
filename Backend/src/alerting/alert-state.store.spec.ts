import { ConfigService } from '@nestjs/config';
import {
  AlertStateStore,
  TRANSITION,
  alertStateKey,
} from './alert-state.store';
import type { RedisService } from '../redis/redis.service';

/**
 * Deduplication is the requirement most visible to whoever is on call: get it
 * wrong in one direction and the channel is unusable, wrong in the other and a
 * real incident is silent. These tests pin both directions, plus the incident
 * duration that makes a re-notification readable.
 */

/**
 * An in-memory stand-in for the Redis surface AlertStateStore uses, honouring
 * the SET NX semantics the dedupe depends on. A stub rather than a mock so the
 * compare-and-set behaviour is actually exercised, not just asserted on.
 */
function fakeRedis() {
  const store = new Map<string, string>();

  const client = {
    set: jest.fn(
      (
        key: string,
        value: string,
        _ex: 'EX',
        _ttl: number,
        nx?: 'NX',
      ): Promise<'OK' | null> => {
        if (nx === 'NX' && store.has(key)) return Promise.resolve(null);
        store.set(key, value);
        return Promise.resolve('OK');
      },
    ),
  };

  const redis = {
    getClient: () => client,
    get: jest.fn((key: string) => {
      const raw = store.get(key);
      if (raw === undefined) return Promise.resolve(null);
      try {
        return Promise.resolve(JSON.parse(raw) as unknown);
      } catch {
        return Promise.resolve(raw);
      }
    }),
    setEx: jest.fn((key: string, _ttl: number, value: unknown) => {
      store.set(key, JSON.stringify(value));
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

  return { redis: redis as unknown as RedisService, store, client };
}

function buildStore(env: Record<string, string> = {}) {
  const { redis, store, client } = fakeRedis();
  const config = {
    get: (key: string) => env[key],
  } as unknown as ConfigService;

  return { alerts: new AlertStateStore(redis, config), store, redis, client };
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

describe('AlertStateStore', () => {
  it('activates the first time a condition fires', async () => {
    const { alerts } = buildStore();

    const outcome = await alerts.markFiring('queue_backlog{queue="sms"}');

    expect(outcome.transition).toBe(TRANSITION.ACTIVATED);
    // Nothing to report on the first message — "still active — 0s" is noise.
    expect(outcome.activeForMs).toBe(0);
  });

  it('suppresses while the condition stays active — the anti-spam rule', async () => {
    // Re-notification off, so this isolates pure suppression.
    const { alerts } = buildStore({ ALERT_RENOTIFY_MIN: '0' });
    await alerts.markFiring('queue_backlog{queue="sms"}');

    for (let i = 0; i < 5; i++) {
      const outcome = await alerts.markFiring('queue_backlog{queue="sms"}');
      expect(outcome.transition).toBe(TRANSITION.SUPPRESSED);
    }
  });

  it('resolves only when there was an active alert', async () => {
    const { alerts } = buildStore();

    // Never fired → nothing to resolve. A "✅ Resolved" for a non-incident is
    // worse than noise; it is misinformation.
    expect(await alerts.markCleared('queue_backlog{queue="sms"}')).toBeNull();

    await alerts.markFiring('queue_backlog{queue="sms"}');
    expect(
      (await alerts.markCleared('queue_backlog{queue="sms"}'))?.transition,
    ).toBe(TRANSITION.RESOLVED);

    // Second clear is a no-op — resolution notifies exactly once.
    expect(await alerts.markCleared('queue_backlog{queue="sms"}')).toBeNull();
  });

  it('re-activates after resolution, so a recurring condition alerts again', async () => {
    const { alerts } = buildStore();

    await alerts.markFiring('queue_backlog{queue="sms"}');
    await alerts.markCleared('queue_backlog{queue="sms"}');

    expect(
      (await alerts.markFiring('queue_backlog{queue="sms"}')).transition,
    ).toBe(TRANSITION.ACTIVATED);
  });

  it('keeps distinct dedupe keys independent', async () => {
    const { alerts } = buildStore();

    await alerts.markFiring('queue_backlog{queue="sms"}');

    // A backlog on another queue is its own incident.
    expect(
      (await alerts.markFiring('queue_backlog{queue="image-processing"}'))
        .transition,
    ).toBe(TRANSITION.ACTIVATED);
  });

  it('lets exactly one racing caller win the activation', async () => {
    // Two app instances observing the same condition in the same second: only
    // one may notify. This is what the in-process Map in ops/AlertService
    // cannot do, and the reason state lives in Redis.
    const { alerts } = buildStore();

    const results = await Promise.all([
      alerts.markFiring('backend_health{component="redis"}'),
      alerts.markFiring('backend_health{component="redis"}'),
      alerts.markFiring('backend_health{component="redis"}'),
    ]);

    expect(
      results.filter((r) => r.transition === TRANSITION.ACTIVATED),
    ).toHaveLength(1);
  });

  describe('re-notification', () => {
    it('re-notifies every 30 minutes by default', async () => {
      // ON by default: an alert that fires once and goes silent is
      // indistinguishable from one that resolved.
      const { alerts } = buildStore();
      const start = Date.now();

      await alerts.markFiring('queue_backlog{queue="sms"}', start);

      expect(
        (
          await alerts.markFiring(
            'queue_backlog{queue="sms"}',
            start + 31 * MINUTE,
          )
        ).transition,
      ).toBe(TRANSITION.RENOTIFY);
    });

    it('can be disabled with ALERT_RENOTIFY_MIN=0', async () => {
      const { alerts } = buildStore({ ALERT_RENOTIFY_MIN: '0' });
      const start = Date.now();

      await alerts.markFiring('queue_backlog{queue="sms"}', start);

      expect(
        (
          await alerts.markFiring(
            'queue_backlog{queue="sms"}',
            start + 6 * HOUR,
          )
        ).transition,
      ).toBe(TRANSITION.SUPPRESSED);
    });

    it('stays quiet until the interval has elapsed', async () => {
      const { alerts } = buildStore({ ALERT_RENOTIFY_MIN: '30' });
      const start = Date.now();

      await alerts.markFiring('k', start);

      expect(
        (await alerts.markFiring('k', start + 20 * MINUTE)).transition,
      ).toBe(TRANSITION.SUPPRESSED);
      expect(
        (await alerts.markFiring('k', start + 31 * MINUTE)).transition,
      ).toBe(TRANSITION.RENOTIFY);
    });

    it('restarts the interval from the re-notification, not the activation', async () => {
      const { alerts } = buildStore({ ALERT_RENOTIFY_MIN: '30' });
      const start = Date.now();

      await alerts.markFiring('k', start);
      await alerts.markFiring('k', start + 31 * MINUTE);

      // 40 min after activation is only 9 min after the last notification.
      expect(
        (await alerts.markFiring('k', start + 40 * MINUTE)).transition,
      ).toBe(TRANSITION.SUPPRESSED);
    });

    it('reports total incident age, measured from the FIRST activation', async () => {
      // This is what turns a repeat into "still active — 3h 25m". Measuring
      // from the last notification instead would reset the clock every 30 min
      // and permanently understate a long incident.
      const { alerts } = buildStore({ ALERT_RENOTIFY_MIN: '30' });
      const start = Date.now();

      await alerts.markFiring('k', start);
      await alerts.markFiring('k', start + 31 * MINUTE);

      const outcome = await alerts.markFiring(
        'k',
        start + 3 * HOUR + 25 * MINUTE,
      );

      expect(outcome.transition).toBe(TRANSITION.RENOTIFY);
      expect(outcome.activeForMs).toBe(3 * HOUR + 25 * MINUTE);
    });
  });

  it('reports how long an alert was active when it resolves', async () => {
    const { alerts } = buildStore();
    const start = Date.now();

    await alerts.markFiring('k', start);
    const outcome = await alerts.markCleared('k', start + 2 * HOUR);

    expect(outcome?.transition).toBe(TRANSITION.RESOLVED);
    expect(outcome?.activeForMs).toBe(2 * HOUR);
  });

  it('enumerates active keys without their storage prefix', async () => {
    const { alerts } = buildStore();

    await alerts.markFiring('queue_backlog{queue="sms"}');
    await alerts.markFiring('backend_health{component="redis"}');

    expect((await alerts.activeKeys()).sort()).toEqual([
      'backend_health{component="redis"}',
      'queue_backlog{queue="sms"}',
    ]);
  });

  it('treats a malformed state row as absent rather than crashing', async () => {
    const { alerts, store } = buildStore();
    store.set(alertStateKey('queue_backlog{queue="sms"}'), 'not-json');

    // The SET NX loses (row exists), the read finds garbage → re-activate
    // rather than letting a corrupt key suppress the alert forever.
    expect(
      (await alerts.markFiring('queue_backlog{queue="sms"}')).transition,
    ).toBe(TRANSITION.ACTIVATED);
  });
});
