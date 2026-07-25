import { ConfigService } from '@nestjs/config';
import { AlertService } from './alert.service';
import { ALERT_TYPES, type Alert, type AlertChannel } from './alert.types';

/** ConfigService double returning only the env values under test. */
function configWith(values: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function alertAt(firedAt: Date, overrides: Partial<Alert> = {}): Alert {
  return {
    type: ALERT_TYPES.FAILED_JOBS,
    severity: 'warning',
    queue: 'sms',
    message: 'failed jobs',
    context: {},
    firedAt,
    ...overrides,
  };
}

/** Recording channel so tests assert on what was actually delivered. */
class RecordingChannel implements AlertChannel {
  readonly name = 'recording';
  readonly delivered: Alert[] = [];
  deliver(alert: Alert): void {
    this.delivered.push(alert);
  }
}

describe('AlertService', () => {
  const t0 = new Date('2026-07-25T10:00:00Z');
  const minutes = (n: number) => new Date(t0.getTime() + n * 60_000);

  it('dispatches the first alert to every registered channel', async () => {
    const service = new AlertService(configWith());
    const channel = new RecordingChannel();
    service.registerChannel(channel);

    const fired = await service.raise(alertAt(t0));

    expect(fired).toBe(true);
    expect(channel.delivered).toHaveLength(1);
    expect(channel.delivered[0].type).toBe(ALERT_TYPES.FAILED_JOBS);
  });

  it('suppresses a repeat of the same type+queue inside the cooldown', async () => {
    const service = new AlertService(
      configWith({ QUEUE_ALERT_COOLDOWN_MIN: '15' }),
    );
    const channel = new RecordingChannel();
    service.registerChannel(channel);

    await service.raise(alertAt(t0));
    const second = await service.raise(alertAt(minutes(5)));
    const third = await service.raise(alertAt(minutes(14)));

    expect(second).toBe(false);
    expect(third).toBe(false);
    // Only the original was delivered — this is the anti-spam guarantee.
    expect(channel.delivered).toHaveLength(1);
  });

  it('re-fires after the cooldown and reports how many were suppressed', async () => {
    const service = new AlertService(
      configWith({ QUEUE_ALERT_COOLDOWN_MIN: '15' }),
    );
    const channel = new RecordingChannel();
    service.registerChannel(channel);

    await service.raise(alertAt(t0));
    await service.raise(alertAt(minutes(5)));
    await service.raise(alertAt(minutes(10)));
    const refired = await service.raise(alertAt(minutes(16)));

    expect(refired).toBe(true);
    expect(channel.delivered).toHaveLength(2);
    // The two swallowed occurrences are accounted for, not lost.
    expect(channel.delivered[1].context.suppressedSinceLastAlert).toBe(2);
  });

  it('alerts on different queues independently', async () => {
    const service = new AlertService(
      configWith({ QUEUE_ALERT_COOLDOWN_MIN: '15' }),
    );
    const channel = new RecordingChannel();
    service.registerChannel(channel);

    await service.raise(alertAt(t0, { queue: 'sms' }));
    const other = await service.raise(
      alertAt(minutes(1), { queue: 'image-processing' }),
    );

    // A backlog on one queue must never mask one on another.
    expect(other).toBe(true);
    expect(channel.delivered.map((a) => a.queue)).toEqual([
      'sms',
      'image-processing',
    ]);
  });

  it('alerts on different types for the same queue independently', async () => {
    const service = new AlertService(
      configWith({ QUEUE_ALERT_COOLDOWN_MIN: '15' }),
    );
    const channel = new RecordingChannel();
    service.registerChannel(channel);

    await service.raise(alertAt(t0, { type: ALERT_TYPES.FAILED_JOBS }));
    const other = await service.raise(
      alertAt(minutes(1), { type: ALERT_TYPES.NO_ACTIVE_WORKERS }),
    );

    expect(other).toBe(true);
    expect(channel.delivered).toHaveLength(2);
  });

  it('re-alerts immediately after resolve() clears the cooldown', async () => {
    const service = new AlertService(
      configWith({ QUEUE_ALERT_COOLDOWN_MIN: '60' }),
    );
    const channel = new RecordingChannel();
    service.registerChannel(channel);

    await service.raise(alertAt(t0));
    service.resolve({ type: ALERT_TYPES.FAILED_JOBS, queue: 'sms' });
    const afterRecovery = await service.raise(alertAt(minutes(2)));

    // A condition that recovered and re-broke is a NEW incident.
    expect(afterRecovery).toBe(true);
    expect(channel.delivered).toHaveLength(2);
  });

  it('keeps delivering to healthy channels when one throws', async () => {
    const service = new AlertService(configWith());
    const healthy = new RecordingChannel();
    service.registerChannel({
      name: 'broken',
      deliver: () => {
        throw new Error('transport down');
      },
    });
    service.registerChannel(healthy);

    await expect(service.raise(alertAt(t0))).resolves.toBe(true);
    expect(healthy.delivered).toHaveLength(1);
  });
});
