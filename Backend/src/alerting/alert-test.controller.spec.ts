import {
  AlertTestController,
  TEST_ALERT_DEDUPE_KEY,
} from './alert-test.controller';
import type { AlertNotifierService } from './alert-notifier.service';
import {
  ALERT_STATE,
  AlertSeverity,
  alertFingerprint,
  type AlertChannel,
  type AlertNotification,
  type AlertSource,
} from './alerting.types';

/**
 * Requirement: the endpoint must exercise the REAL delivery path and must never
 * report success when nothing could be sent. The second half is the point — a
 * smoke test that green-lights a silent drop is worse than no smoke test.
 */

const SOURCE: AlertSource = {
  version: '2.8.14',
  commit: '81e6fd3',
  host: 'backend-02',
  instance: 'worker-3',
  pid: 4242,
};

/** A channel stub with configurable readiness and severity floor. */
function stubChannel(
  name: string,
  configured = true,
  minSeverity = AlertSeverity.WARNING,
): AlertChannel {
  return {
    name,
    configured,
    accepts: (n: AlertNotification) => n.severity >= minSeverity,
    deliver: jest.fn().mockResolvedValue(undefined),
  };
}

function build(channels: AlertChannel[] = [stubChannel('telegram')]) {
  const notifier = {
    notify: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<AlertNotifierService>;
  const controller = new AlertTestController(notifier, channels, SOURCE);
  return { controller, notifier };
}

describe('AlertTestController', () => {
  it('pushes a well-formed notification through the real notifier', async () => {
    const { controller, notifier } = build();

    await controller.test({});

    expect(notifier.notify).toHaveBeenCalledTimes(1);
    const sent = (notifier.notify as jest.Mock).mock
      .calls[0][0] as AlertNotification;
    expect(sent.dedupeKey).toBe(TEST_ALERT_DEDUPE_KEY);
    expect(sent.fingerprint).toBe(alertFingerprint(TEST_ALERT_DEDUPE_KEY));
    expect(sent.state).toBe(ALERT_STATE.ACTIVE);
    expect(sent.source).toBe(SOURCE);
    expect(sent.firedAt).toBeGreaterThan(0);
  });

  // The whole reason the default is not INFO: the channel floor is WARNING, so
  // an INFO default would be filtered out and the endpoint would report success
  // while sending nothing.
  it('defaults to WARNING so the default test is not silently dropped', async () => {
    const { controller, notifier } = build([
      stubChannel('telegram', true, AlertSeverity.WARNING),
    ]);

    const res = await controller.test({});

    const sent = (notifier.notify as jest.Mock).mock
      .calls[0][0] as AlertNotification;
    expect(sent.severity).toBe(AlertSeverity.WARNING);
    expect(res.severity).toBe('WARNING');
    expect(res.channels).toEqual(['telegram']);
  });

  it('reports NO channels when the severity is below the floor', async () => {
    const { controller } = build([
      stubChannel('telegram', true, AlertSeverity.WARNING),
    ]);

    const res = await controller.test({ severity: 'info' });

    expect(res.channels).toEqual([]);
    expect(res.hint).toContain('MIN_SEVERITY');
  });

  it('reports NO channels when nothing is configured', async () => {
    const { controller } = build([stubChannel('telegram', false)]);

    const res = await controller.test({});

    expect(res.channels).toEqual([]);
    expect(res.hint).toContain('ALERT_TELEGRAM_CHAT_ID');
  });

  it('honours an explicit severity and custom text', async () => {
    const { controller, notifier } = build();

    const res = await controller.test({
      severity: 'critical',
      title: 'Custom Title',
      message: 'Custom body',
    });

    const sent = (notifier.notify as jest.Mock).mock
      .calls[0][0] as AlertNotification;
    expect(sent.severity).toBe(AlertSeverity.CRITICAL);
    expect(sent.title).toBe('Custom Title');
    expect(sent.summary).toBe('Custom body');
    expect(res.severity).toBe('CRITICAL');
  });

  it('falls back to the default text when given blanks', async () => {
    const { controller, notifier } = build();

    await controller.test({ title: '   ', message: '' });

    const sent = (notifier.notify as jest.Mock).mock
      .calls[0][0] as AlertNotification;
    expect(sent.title).toBe('Telegram Test');
    expect(sent.summary).not.toBe('');
  });

  // firedAt keys the delivery jobId, so two consecutive tests must not collapse
  // into a single BullMQ job.
  it('gives consecutive tests distinct firedAt values', async () => {
    const { controller, notifier } = build();
    jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(1_700_000_000_000)
      .mockReturnValueOnce(1_700_000_000_500);

    await controller.test({});
    await controller.test({});

    const calls = (notifier.notify as jest.Mock).mock.calls;
    expect(calls[0][0].firedAt).not.toBe(calls[1][0].firedAt);
    jest.restoreAllMocks();
  });

  // notify() swallows per-channel delivery failures by contract, so anything it
  // DOES throw is infrastructure (e.g. Redis unreachable). That must surface as
  // a 500 rather than a cheerful "enqueued" — the caller is running a smoke test
  // precisely to learn that the pipeline is broken.
  it('surfaces an infrastructure failure instead of reporting success', async () => {
    const { controller, notifier } = build();
    (notifier.notify as jest.Mock).mockRejectedValue(new Error('redis down'));

    await expect(controller.test({})).rejects.toThrow('redis down');
  });
});
