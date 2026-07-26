import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AlertNotifierService } from './alert-notifier.service';
import { AlertSilenceService } from './alert-silence.service';
import {
  AlertStateStore,
  TRANSITION,
  type Transition,
} from './alert-state.store';
import {
  resolveAlertingConfig,
  resolveRuleLinkTemplates,
} from './alerting.config';
import { ALERT_SOURCE } from './build-info';
import {
  ALERT_RULES,
  ALERT_STATE,
  AlertSeverity,
  alertFingerprint,
  payloadDedupeKey,
  renderUrlTemplate,
  ruleNameOf,
  severityName,
  type AlertLabels,
  type AlertLinks,
  type AlertNotification,
  type AlertPayload,
  type AlertRule,
  type AlertSource,
  type AlertValues,
} from './alerting.types';

/**
 * Severity a resolution is delivered at.
 *
 * INFO deliberately: a channel configured for ERROR-and-above wants to be told
 * about failures, not recoveries. Teams that DO want every recovery set
 * ALERT_TELEGRAM_MIN_SEVERITY=INFO.
 */
const RESOLVED_SEVERITY = AlertSeverity.INFO;

/**
 * Runs every rule, reconciles what is firing against persisted state, and emits
 * exactly the notifications the transitions call for.
 *
 * This is the ONLY place that decides whether a message is sent. Rules report
 * facts; the store records state; the silence service decides whether now is a
 * sane time to speak; this class owns the machine between them. That is what
 * keeps a new rule to "implement `evaluate`, add to the list" — dedupe,
 * resolution, suppression and notification are inherited, not re-implemented.
 *
 * ── One evaluation ──
 *  1. Run every rule CONCURRENTLY, isolating failures (a throwing rule must
 *     never stop the others; a broken image-latency rule cannot hide a database
 *     outage).
 *  2. Stamp environment labels onto each payload and derive its dedupe key.
 *  3. Drop anything currently suppressed (startup grace / maintenance /
 *     silence) BEFORE it touches state — see `reconcile`.
 *  4. For each firing alert → markFiring → ACTIVATED / RENOTIFY / SUPPRESSED.
 *  5. For each key that WAS active but is no longer firing → markCleared →
 *     RESOLVED.
 *
 * ── Why resolution is derived, not declared ──
 * A rule never says "this resolved". It reports what is true NOW, and anything
 * previously active and absent from that set has recovered by definition. So a
 * rule cannot forget to resolve its own alert, and a rule that crashes mid-run
 * does not spuriously resolve everything it owns — see the `failedRules` guard.
 */
@Injectable()
export class AlertEvaluatorService {
  private readonly logger = new Logger(AlertEvaluatorService.name);
  private readonly environmentLabel: string;

  /**
   * The payload each active alert last fired with, so a RESOLVED message can
   * report the threshold that was breached. Purely cosmetic: state itself lives
   * in Redis, and a missing entry (after a restart) degrades the resolution
   * message's detail without affecting the transition.
   */
  private readonly lastPayloads = new Map<string, AlertPayload>();

  /**
   * Each rule's dashboard/runbook URL TEMPLATES, resolved once at construction.
   *
   * Config lookup and base-URL joining do not depend on the firing alert, so
   * doing them per evaluation would repeat the same work every minute forever.
   * Only the `{{label}}` substitution is per-alert.
   */
  private readonly linkTemplates: ReadonlyMap<
    string,
    { dashboard?: string; runbook?: string }
  >;

  constructor(
    @Inject(ALERT_RULES) private readonly rules: readonly AlertRule[],
    private readonly state: AlertStateStore,
    private readonly notifier: AlertNotifierService,
    private readonly silence: AlertSilenceService,
    @Inject(ALERT_SOURCE) private readonly source: AlertSource,
    config: ConfigService,
  ) {
    this.environmentLabel = resolveAlertingConfig(config).environmentLabel;
    this.linkTemplates = new Map(
      rules.map((rule) => [rule.name, resolveRuleLinkTemplates(rule, config)]),
    );
  }

  /**
   * Resolve this alert's links: the rule's templates with `{{label}}` filled in
   * from the firing instance's labels.
   *
   * That substitution is the whole point — it turns one declaration into a link
   * that lands on the image-processing panel for an image backlog and the SMS
   * panel for an SMS one, instead of a generic overview the operator then has
   * to filter by hand while the incident runs.
   */
  private linksFor(rule: string, labels: AlertLabels): AlertLinks {
    const templates = this.linkTemplates.get(rule);
    if (templates === undefined) return {};

    const dashboard = renderUrlTemplate(templates.dashboard, labels);
    const runbook = renderUrlTemplate(templates.runbook, labels);

    return {
      ...(dashboard !== undefined ? { dashboard } : {}),
      ...(runbook !== undefined ? { runbook } : {}),
    };
  }

  /**
   * Run one full evaluation. Public so it can be triggered directly by the
   * scheduler, by an admin endpoint, or by a test without waiting for a tick.
   *
   * Never throws: this is invoked from a timer, and an unhandled rejection in a
   * scheduled callback would take down the process it is meant to watch.
   */
  async evaluate(now = Date.now()): Promise<void> {
    const { firing, failedRules } = await this.runRules();

    try {
      await this.reconcile(firing, failedRules, now);
    } catch (err) {
      this.logger.error(
        `Alert reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Execute every rule concurrently, isolating failures.
   *
   * Returns the firing alerts keyed by their DERIVED dedupe key, plus the names
   * of rules that THREW. A failed rule yields no firing alerts, which would
   * otherwise look identical to "all of its alerts recovered" — so its name is
   * tracked and its alerts are left untouched during reconciliation.
   */
  private async runRules(): Promise<{
    firing: Map<string, AlertPayload>;
    failedRules: Set<string>;
  }> {
    const firing = new Map<string, AlertPayload>();
    const failedRules = new Set<string>();

    const results = await Promise.all(
      this.rules.map(async (rule) => {
        try {
          return { rule, result: await rule.evaluate() };
        } catch (err) {
          this.logger.error(
            `Alert rule "${rule.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          failedRules.add(rule.name);
          return null;
        }
      }),
    );

    for (const entry of results) {
      if (entry === null) continue;
      for (const raw of entry.result.firing) {
        const payload = this.withEnvironmentLabels(raw);
        firing.set(payloadDedupeKey(payload), payload);
      }
    }

    return { firing, failedRules };
  }

  /**
   * Stamp the environment onto every alert's labels.
   *
   * Applied centrally rather than in each rule so it cannot be forgotten, and
   * so `environment` participates in the dedupe key — two deployments sharing
   * one Redis never collapse into a single alert.
   */
  private withEnvironmentLabels(payload: AlertPayload): AlertPayload {
    const labels: AlertLabels = {
      ...payload.labels,
      environment: this.environmentLabel.toLowerCase(),
    };
    return { ...payload, labels };
  }

  /** Apply the state machine to this evaluation's firing set. */
  private async reconcile(
    firing: ReadonlyMap<string, AlertPayload>,
    failedRules: ReadonlySet<string>,
    now: number,
  ): Promise<void> {
    const activeBefore = new Set(await this.state.activeKeys());

    // ── Firing → ACTIVATED / RENOTIFY / SUPPRESSED ──
    for (const [dedupeKey, payload] of firing) {
      // Every log line about this alert carries `[FINGERPRINT]`, so one grep
      // returns the incident's whole lifecycle across all components.
      const id = alertFingerprint(dedupeKey);

      const suppression = await this.silence.suppressionFor(payload, now);
      if (suppression !== null) {
        // Deliberately BEFORE markFiring: a suppressed alert must not consume
        // its own ACTIVATED transition, or the condition would be recorded as
        // "already notified" and stay silent forever once the silence lifts.
        this.logger.debug(
          `[${id}] Suppressed ${dedupeKey} — ${this.silence.describe(suppression)}`,
        );
        continue;
      }

      this.lastPayloads.set(dedupeKey, payload);
      const { transition, activeForMs } = await this.state.markFiring(
        dedupeKey,
        now,
      );

      if (
        transition === TRANSITION.ACTIVATED ||
        transition === TRANSITION.RENOTIFY
      ) {
        await this.notifyActive(
          dedupeKey,
          payload,
          transition,
          activeForMs,
          now,
        );
      }
    }

    // ── Previously active, no longer firing → RESOLVED ──
    for (const dedupeKey of activeBefore) {
      if (firing.has(dedupeKey)) continue;

      // A rule that THREW reported nothing, which is not evidence of recovery.
      // Leaving its alerts active is the safe read: a still-broken condition
      // stays visible, and it resolves on the next successful evaluation.
      if (failedRules.has(ruleNameOf(dedupeKey))) {
        this.logger.debug(
          `[${alertFingerprint(dedupeKey)}] Not resolving "${dedupeKey}" — ` +
            `its rule failed this evaluation`,
        );
        continue;
      }

      const outcome = await this.state.markCleared(dedupeKey, now);
      if (outcome?.transition === TRANSITION.RESOLVED) {
        await this.notifyResolved(dedupeKey, outcome.activeForMs, now);
      }
    }
  }

  /**
   * Ask the owning rule for the CURRENT measurements of a recovered alert.
   *
   * Optional per rule, and isolated: a rule whose hook throws still gets its
   * alert resolved, just with the cached firing values.
   */
  private async freshResolvedValues(
    dedupeKey: string,
    payload: AlertPayload | undefined,
  ): Promise<AlertValues | undefined> {
    const rule = this.rules.find((r) => r.name === ruleNameOf(dedupeKey));
    if (rule?.resolvedValuesFor === undefined) return undefined;

    try {
      return await rule.resolvedValuesFor(payload?.labels ?? {});
    } catch (err) {
      this.logger.debug(
        `resolvedValuesFor("${dedupeKey}") failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  /** Send the ACTIVE (or re-notified) message. */
  private async notifyActive(
    dedupeKey: string,
    payload: AlertPayload,
    transition: Transition,
    activeForMs: number,
    now: number,
  ): Promise<void> {
    const renotification = transition === TRANSITION.RENOTIFY;
    const fingerprint = alertFingerprint(dedupeKey);

    this.logger.warn(
      `[${fingerprint}] Alert ${transition}: ${dedupeKey} — ${payload.summary} ` +
        `[${severityName(payload.severity)}]`,
    );

    await this.notifier.notify({
      dedupeKey,
      fingerprint,
      state: ALERT_STATE.ACTIVE,
      rule: payload.rule,
      severity: payload.severity,
      labels: payload.labels,
      values: payload.values,
      title: payload.title,
      summary: payload.summary,
      links: this.linksFor(payload.rule, payload.labels),
      source: this.source,
      firedAt: now,
      // Only on a re-notification: the first message has nothing to report and
      // "still active — 0s" would read as noise.
      ...(renotification ? { activeForMs, renotification: true } : {}),
    });
  }

  /**
   * Send the RESOLVED message, using the payload the alert last fired with so
   * the message can still name the threshold that was breached.
   */
  private async notifyResolved(
    dedupeKey: string,
    activeForMs: number,
    now: number,
  ): Promise<void> {
    const previous = this.lastPayloads.get(dedupeKey);
    this.lastPayloads.delete(dedupeKey);
    const fingerprint = alertFingerprint(dedupeKey);

    this.logger.log(`[${fingerprint}] Alert RESOLVED: ${dedupeKey}`);

    // Prefer a freshly re-read value ("Current: 18") over the one that tripped
    // the alert ("Current: 186"), which would contradict the word "Resolved".
    const fresh = await this.freshResolvedValues(dedupeKey, previous);

    const notification: AlertNotification = {
      dedupeKey,
      fingerprint,
      state: ALERT_STATE.RESOLVED,
      // After a restart the payload is gone; the key is still meaningful and a
      // terse resolution beats no resolution at all.
      rule: previous?.rule ?? ruleNameOf(dedupeKey),
      // A recovery is informational — it is good news, and routing it at the
      // original severity would page someone about a problem that just ended.
      severity: RESOLVED_SEVERITY,
      labels: previous?.labels ?? {},
      values: fresh ?? previous?.resolvedValues ?? previous?.values ?? {},
      title: previous?.title ?? dedupeKey,
      summary: previous?.summary ?? dedupeKey,
      // A resolution carries no links: the incident is over, so "open the
      // dashboard" and "follow the runbook" are no longer the actions being
      // asked for. Keeping the message terse is the point of a recovery notice.
      links: {},
      source: this.source,
      firedAt: now,
      activeForMs,
    };

    await this.notifier.notify(notification);
  }
}
