import { ConfigService } from '@nestjs/config';
import { AlertEvaluatorService } from './alert-evaluator.service';
import type { AlertNotifierService } from './alert-notifier.service';
import type { AlertSilenceService } from './alert-silence.service';
import { TRANSITION, type AlertStateStore } from './alert-state.store';
import {
  ALERT_STATE,
  AlertSeverity,
  NO_ALERTS,
  alertFingerprint,
  ruleNameOf,
  type AlertNotification,
  type AlertPayload,
  type AlertRule,
  type AlertSource,
  type RuleResult,
} from './alerting.types';

/**
 * The evaluator owns the ACTIVE→RESOLVED state machine, suppression, and the
 * isolation guarantees. These tests cover the behaviours that stay invisible
 * until they fail in production: a crashing rule silently "resolving"
 * everything it owns, and a silenced alert burning its own activation.
 */

function configWith(env: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

/** Fixed build/host identity, so assertions can pin what lands in a message. */
const SOURCE: AlertSource = {
  version: '2.8.14',
  commit: '81e6fd3',
  host: 'backend-02',
  instance: 'worker-3',
  pid: 4242,
};

/** A rule that returns whatever is queued for it, or throws. */
function stubRule(name: string, behaviour: RuleResult | Error) {
  return {
    name,
    evaluate: jest.fn(() =>
      behaviour instanceof Error
        ? Promise.reject(behaviour)
        : Promise.resolve(behaviour),
    ),
  } as unknown as jest.Mocked<AlertRule> & AlertRule;
}

function payload(over: Partial<AlertPayload> = {}): AlertPayload {
  return {
    rule: 'queue_backlog',
    severity: AlertSeverity.ERROR,
    labels: { queue: 'sms' },
    values: { waiting: 150, threshold: 100 },
    title: 'Sms Queue Backlog',
    summary: 'sms queue backlog',
    ...over,
  };
}

/** A state store stub whose transitions the test dictates. */
function stubStore(active: string[] = []) {
  return {
    markFiring: jest.fn(() =>
      Promise.resolve({ transition: TRANSITION.ACTIVATED, activeForMs: 0 }),
    ),
    markCleared: jest.fn(() =>
      Promise.resolve({ transition: TRANSITION.RESOLVED, activeForMs: 0 }),
    ),
    activeKeys: jest.fn(() => Promise.resolve(active)),
    get: jest.fn(() => Promise.resolve(null)),
  } as unknown as jest.Mocked<AlertStateStore>;
}

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

/** A silence service that suppresses nothing unless told otherwise. */
function stubSilence() {
  return {
    suppressionFor: jest.fn(() => Promise.resolve(null)),
    describe: jest.fn(() => 'maintenance mode'),
  } as unknown as jest.Mocked<AlertSilenceService>;
}

function buildEvaluator(
  rules: AlertRule[],
  store = stubStore(),
  silence = stubSilence(),
) {
  const { notifier, sent } = stubNotifier();
  const evaluator = new AlertEvaluatorService(
    rules,
    store,
    notifier,
    silence,
    SOURCE,
    configWith({ ALERT_ENVIRONMENT_LABEL: 'Production' }),
  );
  return { evaluator, store, notifier, sent, silence };
}

describe('AlertEvaluatorService', () => {
  it('notifies ACTIVE when a rule starts firing', async () => {
    const { evaluator, sent } = buildEvaluator([
      stubRule('queue_backlog', { firing: [payload()] }),
    ]);

    await evaluator.evaluate(1_000);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      state: ALERT_STATE.ACTIVE,
      rule: 'queue_backlog',
      severity: AlertSeverity.ERROR,
      title: 'Sms Queue Backlog',
      firedAt: 1_000,
    });
  });

  it('derives a Prometheus-shaped dedupe key from rule + labels', () => {
    // Identity is derived, never hand-built by a rule — so a rule cannot forget
    // to fold a dimension into its key and collapse two incidents into one.
    const { evaluator, sent, store } = buildEvaluator([
      stubRule('queue_backlog', { firing: [payload()] }),
    ]);

    return evaluator.evaluate().then(() => {
      expect(sent[0].dedupeKey).toBe(
        'queue_backlog{environment="production",queue="sms"}',
      );
      expect(store.markFiring).toHaveBeenCalledWith(
        'queue_backlog{environment="production",queue="sms"}',
        expect.any(Number),
      );
    });
  });

  it('stamps a fingerprint derived from the dedupe key', async () => {
    // The same short id appears in the message and in every log line about this
    // alert, so `grep A7F91B` returns the whole incident lifecycle.
    const { evaluator, sent } = buildEvaluator([
      stubRule('queue_backlog', { firing: [payload()] }),
    ]);

    await evaluator.evaluate();

    expect(sent[0].fingerprint).toBe(alertFingerprint(sent[0].dedupeKey));
  });

  it('keeps the fingerprint stable across activation, re-notification and resolution', async () => {
    // A random per-message id would make an incident unquotable across its own
    // lifetime — this is why it is derived, not generated.
    const key = 'queue_backlog{environment="production",queue="sms"}';
    const store = stubStore();
    const rule = stubRule('queue_backlog', { firing: [payload()] });
    const { evaluator, sent } = buildEvaluator([rule], store);

    await evaluator.evaluate();

    store.markFiring.mockResolvedValue({
      transition: TRANSITION.RENOTIFY,
      activeForMs: 60_000,
    });
    await evaluator.evaluate();

    rule.evaluate.mockResolvedValue(NO_ALERTS);
    store.activeKeys.mockResolvedValue([key]);
    await evaluator.evaluate();

    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((n) => n.fingerprint)).size).toBe(1);
  });

  describe('links', () => {
    /** A rule declaring a label-templated dashboard, like the real one. */
    function linkedRule(result: RuleResult) {
      return {
        ...stubRule('queue_backlog', result),
        dashboardUrl: '/d/mator-bullmq?var-queue={{queue}}',
      } as unknown as jest.Mocked<AlertRule> & AlertRule;
    }

    function buildLinked(rules: AlertRule[], env: Record<string, string>) {
      const { notifier, sent } = stubNotifier();
      const evaluator = new AlertEvaluatorService(
        rules,
        stubStore(),
        notifier,
        stubSilence(),
        SOURCE,
        configWith({ ALERT_ENVIRONMENT_LABEL: 'Production', ...env }),
      );
      return { evaluator, sent };
    }

    it("resolves the dashboard against the firing alert's own labels", async () => {
      // The point of the templating: the link lands on the panel for the queue
      // that actually broke, not a generic overview to filter by hand.
      const { evaluator, sent } = buildLinked(
        [linkedRule({ firing: [payload({ labels: { queue: 'sms' } })] })],
        { ALERT_GRAFANA_BASE_URL: 'https://grafana.mator.uz' },
      );

      await evaluator.evaluate();

      expect(sent[0].links.dashboard).toBe(
        'https://grafana.mator.uz/d/mator-bullmq?var-queue=sms',
      );
    });

    it('gives each fan-out instance its own dashboard link', async () => {
      const { evaluator, sent } = buildLinked(
        [
          linkedRule({
            firing: [
              payload({ labels: { queue: 'sms' } }),
              payload({ labels: { queue: 'image-processing' } }),
            ],
          }),
        ],
        { ALERT_GRAFANA_BASE_URL: 'https://grafana.mator.uz' },
      );

      await evaluator.evaluate();

      expect(sent.map((n) => n.links.dashboard).sort()).toEqual([
        'https://grafana.mator.uz/d/mator-bullmq?var-queue=image-processing',
        'https://grafana.mator.uz/d/mator-bullmq?var-queue=sms',
      ]);
    });

    it('derives the runbook from the configured base', async () => {
      const { evaluator, sent } = buildLinked(
        [linkedRule({ firing: [payload()] })],
        { ALERT_RUNBOOK_BASE_URL: 'https://wiki.mator.uz/runbooks' },
      );

      await evaluator.evaluate();

      expect(sent[0].links.runbook).toBe(
        'https://wiki.mator.uz/runbooks/queue-backlog',
      );
    });

    it('emits no links when nothing is configured', async () => {
      // An unconfigured deployment renders no link section at all.
      const { evaluator, sent } = buildLinked(
        [linkedRule({ firing: [payload()] })],
        {},
      );

      await evaluator.evaluate();

      expect(sent[0].links).toEqual({});
    });

    it('carries no links on a resolution', async () => {
      // The incident is over — "open the dashboard" is no longer the ask.
      const key = 'queue_backlog{environment="production",queue="sms"}';
      const rule = linkedRule(NO_ALERTS);
      const store = stubStore([key]);
      const { notifier, sent } = stubNotifier();
      const evaluator = new AlertEvaluatorService(
        [rule],
        store,
        notifier,
        stubSilence(),
        SOURCE,
        configWith({
          ALERT_ENVIRONMENT_LABEL: 'Production',
          ALERT_GRAFANA_BASE_URL: 'https://grafana.mator.uz',
        }),
      );

      await evaluator.evaluate();

      expect(sent[0].state).toBe(ALERT_STATE.RESOLVED);
      expect(sent[0].links).toEqual({});
    });
  });

  it('attaches the build/host source to every notification', async () => {
    const { evaluator, sent } = buildEvaluator([
      stubRule('queue_backlog', { firing: [payload()] }),
    ]);

    await evaluator.evaluate();

    expect(sent[0].source).toEqual(SOURCE);
  });

  it('stamps the environment label onto every alert', async () => {
    const { evaluator, sent } = buildEvaluator([
      stubRule('queue_backlog', { firing: [payload()] }),
    ]);

    await evaluator.evaluate();

    expect(sent[0].labels).toEqual({ queue: 'sms', environment: 'production' });
  });

  it('sends nothing when the store suppresses a still-active alert', async () => {
    const store = stubStore();
    store.markFiring.mockResolvedValue({
      transition: TRANSITION.SUPPRESSED,
      activeForMs: 60_000,
    });
    const { evaluator, sent } = buildEvaluator(
      [stubRule('queue_backlog', { firing: [payload()] })],
      store,
    );

    await evaluator.evaluate();

    expect(sent).toHaveLength(0);
  });

  it('re-notifies with the incident duration attached', async () => {
    const store = stubStore();
    store.markFiring.mockResolvedValue({
      transition: TRANSITION.RENOTIFY,
      activeForMs: 3 * 60 * 60 * 1000 + 25 * 60 * 1000,
    });
    const { evaluator, sent } = buildEvaluator(
      [stubRule('queue_backlog', { firing: [payload()] })],
      store,
    );

    await evaluator.evaluate();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      state: ALERT_STATE.ACTIVE,
      renotification: true,
      activeForMs: 3 * 60 * 60 * 1000 + 25 * 60 * 1000,
    });
  });

  it('notifies RESOLVED at INFO when a previously active alert clears', async () => {
    const key = 'queue_backlog{environment="production",queue="sms"}';
    const store = stubStore([key]);
    store.markCleared.mockResolvedValue({
      transition: TRANSITION.RESOLVED,
      activeForMs: 45 * 60 * 1000,
    });
    const { evaluator, sent } = buildEvaluator(
      [stubRule('queue_backlog', NO_ALERTS)],
      store,
    );

    await evaluator.evaluate(2_000);

    expect(store.markCleared).toHaveBeenCalledWith(key, 2_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      state: ALERT_STATE.RESOLVED,
      // A recovery is good news: routing it at the original severity would page
      // someone about a problem that just ended.
      severity: AlertSeverity.INFO,
      activeForMs: 45 * 60 * 1000,
    });
  });

  it('asks the rule for FRESH values when an alert resolves', async () => {
    // Echoing the tripping value ("Current: 186") on a resolution contradicts
    // the word "Resolved" — the rule re-reads and reports the recovered number.
    const key = 'queue_backlog{environment="production",queue="sms"}';
    const rule = stubRule('queue_backlog', { firing: [payload()] });
    (rule as unknown as AlertRule).resolvedValuesFor = jest.fn(() =>
      Promise.resolve({ current: 18, threshold: 100 }),
    );

    const store = stubStore();
    const { evaluator, sent } = buildEvaluator([rule], store);

    await evaluator.evaluate();
    rule.evaluate.mockResolvedValue(NO_ALERTS);
    store.activeKeys.mockResolvedValue([key]);
    await evaluator.evaluate();

    const resolved = sent.find((n) => n.state === ALERT_STATE.RESOLVED);
    expect(resolved?.values).toEqual({ current: 18, threshold: 100 });
  });

  it("still resolves when the rule's fresh-value hook throws", async () => {
    const key = 'queue_backlog{environment="production",queue="sms"}';
    const rule = stubRule('queue_backlog', NO_ALERTS);
    (rule as unknown as AlertRule).resolvedValuesFor = jest.fn(() =>
      Promise.reject(new Error('redis down')),
    );
    const { evaluator, sent } = buildEvaluator([rule], stubStore([key]));

    await evaluator.evaluate();

    expect(sent).toHaveLength(1);
    expect(sent[0].state).toBe(ALERT_STATE.RESOLVED);
  });

  describe('suppression', () => {
    it('does not notify a suppressed alert', async () => {
      const silence = stubSilence();
      silence.suppressionFor.mockResolvedValue({ kind: 'maintenance' });
      const { evaluator, sent } = buildEvaluator(
        [stubRule('queue_backlog', { firing: [payload()] })],
        stubStore(),
        silence,
      );

      await evaluator.evaluate();

      expect(sent).toHaveLength(0);
    });

    it('does not let a suppressed alert consume its own activation', async () => {
      // The subtle one: if suppression ran AFTER markFiring, the condition
      // would be recorded as "already notified" and stay silent forever once
      // the silence lifts.
      const silence = stubSilence();
      silence.suppressionFor.mockResolvedValue({ kind: 'maintenance' });
      const store = stubStore();
      const { evaluator } = buildEvaluator(
        [stubRule('queue_backlog', { firing: [payload()] })],
        store,
        silence,
      );

      await evaluator.evaluate();

      expect(store.markFiring).not.toHaveBeenCalled();
    });
  });

  it('does NOT resolve alerts belonging to a rule that threw', async () => {
    // The critical isolation property: a rule that crashes reports nothing,
    // which must never be mistaken for "everything it owns recovered" —
    // otherwise a broken rule sends a false all-clear during a real incident.
    const store = stubStore(['backend_health{component="database"}']);
    const { evaluator, sent } = buildEvaluator(
      [stubRule('backend_health', new Error('probe exploded'))],
      store,
    );

    await evaluator.evaluate();

    expect(store.markCleared).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('runs every other rule when one throws', async () => {
    const healthy = stubRule('sms_failures', {
      firing: [
        payload({ rule: 'sms_failures', labels: { provider: 'eskiz' } }),
      ],
    });
    const { evaluator, sent } = buildEvaluator([
      stubRule('image_processing_latency', new Error('boom')),
      healthy,
    ]);

    await evaluator.evaluate();

    expect(healthy.evaluate).toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0].rule).toBe('sms_failures');
  });

  it('never throws, even when the state store fails', async () => {
    const store = stubStore();
    store.activeKeys.mockRejectedValue(new Error('redis down'));
    const { evaluator } = buildEvaluator(
      [stubRule('queue_backlog', NO_ALERTS)],
      store,
    );

    // Invoked from a timer — an unhandled rejection here would take down the
    // process this system exists to watch.
    await expect(evaluator.evaluate()).resolves.toBeUndefined();
  });

  it('handles multiple firing instances from one rule independently', async () => {
    const { evaluator, sent } = buildEvaluator([
      stubRule('queue_backlog', {
        firing: [
          payload({ labels: { queue: 'sms' } }),
          payload({ labels: { queue: 'image-processing' } }),
        ],
      }),
    ]);

    await evaluator.evaluate();

    expect(sent.map((n) => n.dedupeKey).sort()).toEqual([
      'queue_backlog{environment="production",queue="image-processing"}',
      'queue_backlog{environment="production",queue="sms"}',
    ]);
  });
});

describe('ruleNameOf', () => {
  it('extracts the rule name from a labelled key', () => {
    expect(ruleNameOf('queue_backlog{queue="image-processing"}')).toBe(
      'queue_backlog',
    );
  });

  it('returns the key itself for a label-less rule', () => {
    expect(ruleNameOf('image_processing_latency')).toBe(
      'image_processing_latency',
    );
  });
});
