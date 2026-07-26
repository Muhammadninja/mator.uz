/**
 * The vocabulary shared by alert rules (producers), the evaluator (dedupe) and
 * the channels (delivery).
 *
 * Deliberately transport-agnostic: nothing here knows Telegram exists. A rule
 * returns a plain description of what it observed; how that becomes a message
 * is the channel's problem. That separation is what lets a rule be unit-tested
 * with no bot, no Redis and no queue — and what lets Slack/Discord/webhook
 * channels be added without touching a single rule.
 *
 * ── Shape ──
 * The payload is modelled on a Prometheus alert: a rule name, a severity, a
 * `labels` map (low-cardinality IDENTITY — what this alert is about) and a
 * `values` map (the NUMBERS that tripped it). Keeping the two apart is what
 * makes grouping, filtering and per-channel routing possible later without
 * re-parsing rendered text, and it is why the dedupe key can be DERIVED from
 * labels rather than hand-built by each rule.
 *
 * NOTE — this is distinct from `src/ops/alert.types.ts`, which is the older
 * queue-monitor-scoped vocabulary (keyed on `type:queue`, log-only, in-process
 * cooldown). Those alerts are BRIDGED into this module (see ops-alert.bridge.ts)
 * rather than duplicated, so there is still exactly one path to a channel.
 */

import { createHash } from 'node:crypto';

/**
 * Where an alert came from and what code was running when it fired.
 *
 * Resolved ONCE at boot (see build-info.ts) and attached to every notification,
 * because the two questions asked first during an incident are "is this the new
 * release or the old one?" and "which instance?" — and both are answerable
 * without a lookup if the message simply says so.
 */
export interface AlertSource {
  /** Deployed version, e.g. `2.8.14`. */
  version: string;
  /** Short git commit the build came from, e.g. `81e6fd3`. Empty when unknown. */
  commit: string;
  /** Hostname of the machine, e.g. `backend-02`. */
  host: string;
  /** PM2 instance label, e.g. `worker-3`. Empty when not under PM2. */
  instance: string;
  /** Process id — disambiguates two instances on one host. */
  pid: number;
}

/**
 * How loudly to report, in ascending order of urgency.
 *
 * Four levels rather than two so a channel can ROUTE on them: INFO to a quiet
 * feed, CRITICAL to whoever is on call. The numeric values are deliberate —
 * they make `severity >= ERROR` a valid comparison, which is exactly the filter
 * a routing rule needs.
 */
export enum AlertSeverity {
  /** Noteworthy, not actionable. Maintenance start/end, recoveries of note. */
  INFO = 10,
  /** Degraded but self-healing or tolerable. Look at it during working hours. */
  WARNING = 20,
  /** Something is failing. Needs attention today. */
  ERROR = 30,
  /** User-facing outage or unrecoverable condition. Wake someone up. */
  CRITICAL = 40,
}

/** Parse a severity from config/env text. Unknown values fall back. */
export function parseSeverity(
  raw: string | undefined,
  fallback: AlertSeverity,
): AlertSeverity {
  if (raw === undefined) return fallback;
  const key = raw.trim().toUpperCase();
  const value = (AlertSeverity as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : fallback;
}

/** The canonical name of a severity, e.g. `CRITICAL`. */
export function severityName(severity: AlertSeverity): string {
  return AlertSeverity[severity] ?? 'UNKNOWN';
}

/** Lifecycle of a single alert instance. */
export const ALERT_STATE = {
  /** The condition is currently true and has been notified. */
  ACTIVE: 'ACTIVE',
  /** The condition was true and has since cleared. */
  RESOLVED: 'RESOLVED',
} as const;

export type AlertState = (typeof ALERT_STATE)[keyof typeof ALERT_STATE];

/**
 * IDENTITY of an alert — low-cardinality dimensions, Prometheus-style.
 *
 * Labels answer "what is this alert about?" (`queue: image-processing`,
 * `provider: eskiz`, `component: database`). They form the dedupe key, so they
 * must be STABLE for the lifetime of one incident: a label that changes
 * between evaluations would resolve the old alert and activate a new one every
 * minute. Never put a measurement in here — that is what `values` is for.
 */
export type AlertLabels = Readonly<Record<string, string>>;

/**
 * The MEASUREMENTS that tripped the rule (`waiting: 186`, `threshold: 100`).
 *
 * Values change freely between evaluations without affecting identity, which is
 * what lets the resolution message report the recovered number while still
 * being recognised as the same alert.
 */
export type AlertValues = Readonly<Record<string, string | number>>;

/**
 * What a rule reports when its condition is TRUE.
 *
 * Note there is no `dedupeKey` field: identity is DERIVED from `rule` + `labels`
 * by {@link alertDedupeKey}. A rule cannot accidentally emit two alerts with the
 * same key but different labels, nor forget to fold a dimension into the key.
 */
export interface AlertPayload {
  /** The rule that produced this, e.g. `queue_backlog`. */
  rule: string;
  severity: AlertSeverity;
  /** Identity. See {@link AlertLabels}. */
  labels: AlertLabels;
  /** Measurements. See {@link AlertValues}. */
  values: AlertValues;
  /** Headline, e.g. "Image Queue Backlog". Rendered in bold. */
  title: string;
  /**
   * One-line human summary used in the RESOLVED message ("... has returned to
   * normal") and in logs. Written as a noun phrase, not a sentence.
   */
  summary: string;
  /**
   * Values shown on the RESOLVED message, when they differ from `values`
   * (typically the recovered reading). Falls back to `values` when omitted.
   */
  resolvedValues?: AlertValues;
}

/**
 * A rule's verdict for one evaluation.
 *
 * `firing` carries every alert instance that is currently true. Anything
 * previously firing for this rule and ABSENT from the list is treated as
 * recovered — which is what makes resolution automatic: a rule never has to
 * remember, or explicitly clear, its own past state.
 */
export interface RuleResult {
  firing: AlertPayload[];
}

/** Nothing wrong — the canonical empty result. */
export const NO_ALERTS: RuleResult = { firing: [] };

/**
 * A single detection rule.
 *
 * Adding a rule means: implement this interface, add the class to `RULES` in
 * alerting.module.ts. No switch statement, no registry file to edit, no change
 * to the evaluator — which is the point.
 *
 * Contract:
 *   • `evaluate` collects its own metrics and returns what is firing NOW. It
 *     must not dedupe, notify, or track history — the evaluator owns all of it.
 *   • Throwing is allowed. The evaluator isolates a failing rule so it can
 *     never stop the others from running.
 */
export interface AlertRule {
  /**
   * Stable machine name, snake_case, e.g. `queue_backlog`. Forms the prefix of
   * every dedupe key the rule emits, so it must be unique across rules.
   */
  readonly name: string;

  /**
   * Where to LOOK when this fires — the Grafana dashboard/panel showing the
   * metric that tripped it.
   *
   * May contain `{{label}}` placeholders, substituted from the firing alert's
   * labels (see {@link renderUrlTemplate}). That is what makes one declaration
   * serve every instance of a fan-out rule: `?var-queue={{queue}}` lands on the
   * image-processing panel for an image backlog and the SMS panel for an SMS
   * one, instead of dumping the operator on a generic overview they then have
   * to filter by hand.
   *
   * Overridable per rule from the environment — see alerting.config.ts — so the
   * URL can be corrected after a dashboard move without a deploy.
   */
  readonly dashboardUrl?: string;

  /**
   * What to DO when this fires — the runbook for this specific condition.
   *
   * Usually one static page per rule (the procedure does not differ by queue),
   * but the same `{{label}}` substitution applies if it does.
   */
  readonly runbookUrl?: string;

  evaluate(): Promise<RuleResult>;

  /**
   * OPTIONAL: the CURRENT measurements for an alert that has just recovered.
   *
   * Without this, a resolution message can only echo the values that TRIPPED
   * the alert ("Current: 186") — which is actively misleading, since the whole
   * point of the message is that the number came back down. A rule that can
   * cheaply re-read its metric implements this to report the real recovered
   * value ("Current: 18").
   *
   * Called with the labels of the resolving alert, so a per-dimension rule
   * knows WHICH queue/provider recovered. Must not throw; return `undefined` to
   * fall back to the cached firing values.
   */
  resolvedValuesFor?(labels: AlertLabels): Promise<AlertValues | undefined>;
}

/** DI token for the injected list of rules. See alerting.module.ts. */
export const ALERT_RULES = Symbol('ALERT_RULES');

/** DI token for the injected list of delivery channels. */
export const ALERT_CHANNELS = Symbol('ALERT_CHANNELS');

/**
 * The dedupe identity of an alert: rule name plus its sorted labels, e.g.
 * `queue_backlog{queue="image-processing"}`.
 *
 * Sorted so label declaration order can never split one incident into two
 * alerts. The Prometheus-ish rendering is deliberate: it is greppable in logs
 * and reads unambiguously in a Redis key.
 */
export function alertDedupeKey(rule: string, labels: AlertLabels = {}): string {
  const entries = Object.entries(labels)
    .filter(([, value]) => value !== '')
    .sort(([a], [b]) => a.localeCompare(b));

  if (entries.length === 0) return rule;

  const rendered = entries.map(([key, value]) => `${key}="${value}"`).join(',');
  return `${rule}{${rendered}}`;
}

/** The dedupe key for a payload. */
export function payloadDedupeKey(payload: AlertPayload): string {
  return alertDedupeKey(payload.rule, payload.labels);
}

/**
 * A short, stable, human-quotable id for an alert: the first
 * {@link FINGERPRINT_LENGTH} hex chars of `sha256(dedupeKey)`, uppercased —
 * e.g. `A7F91B`.
 *
 * ── Why ──
 * Two problems, one identifier. In conversation, "look at A7F91B" beats "that
 * image queue backlog thing on production". In the logs, every line touching an
 * alert carries `[A7F91B]`, so `grep A7F91B` returns the whole lifecycle —
 * activation, suppression, enqueue, each delivery attempt, resolution — across
 * every component, with no correlation table to join.
 *
 * ── Why derived, not random ──
 * A random per-notification id would be useless for the first purpose: the same
 * incident would get a new id every re-notification, and a recurrence next week
 * would be unrelatable to this one. Deriving it from the dedupe key (rule +
 * sorted labels) makes it the STABLE identity of the condition itself, so the
 * same backlog on the same queue always reads as the same fingerprint — which is
 * exactly what makes "is this the same thing as last Tuesday?" answerable.
 *
 * ── Why a hash rather than the key itself ──
 * `queue_backlog{environment="production",queue="image-processing"}` is precise
 * but unusable in speech and awkward in a log grep. The hash is fixed-width,
 * case-insensitive to read aloud, and unambiguous. The full key travels in the
 * payload alongside it, so no information is lost.
 *
 * Collisions: 24 bits ≈ 16.7M values. With the low tens of distinct alert
 * identities this app can produce, a collision is not a practical concern — and
 * the consequence would be cosmetic (two unrelated alerts sharing a short id in
 * chat), never a dedupe error, because dedupe keys off the full key.
 */
export function alertFingerprint(dedupeKey: string): string {
  return createHash('sha256')
    .update(dedupeKey)
    .digest('hex')
    .slice(0, FINGERPRINT_LENGTH)
    .toUpperCase();
}

/** Hex characters kept from the digest. Six reads well and greps cleanly. */
export const FINGERPRINT_LENGTH = 6;

/**
 * Resolved links for one firing alert — where to look, and what to do.
 *
 * Both optional: a rule with no dashboard is still a valid rule, and rendering
 * an empty "Dashboard:" heading would be worse than omitting the section.
 */
export interface AlertLinks {
  /** Grafana dashboard/panel showing the metric that tripped. */
  dashboard?: string;
  /** Runbook for this condition. */
  runbook?: string;
}

/**
 * Substitute `{{label}}` placeholders in a URL template from an alert's labels.
 *
 * `https://grafana/d/queues?var-queue={{queue}}` + `{queue: 'sms'}` →
 * `https://grafana/d/queues?var-queue=sms`.
 *
 * Values are percent-encoded, because a label reaches the URL verbatim and a
 * queue name containing `&` or a space would otherwise produce a broken (or
 * subtly wrong) link. Labels are low-cardinality identifiers we generate, so
 * this is defence in depth rather than a live injection worry — but a link an
 * operator clicks mid-incident has to be right.
 *
 * An UNMATCHED placeholder invalidates the whole URL (returns `undefined`)
 * rather than leaving a literal `{{queue}}` in it: a link that 404s or silently
 * shows the wrong panel costs more time than no link at all, because it is
 * trusted before it is checked.
 */
export function renderUrlTemplate(
  template: string | undefined,
  labels: AlertLabels,
): string | undefined {
  if (template === undefined || template.trim() === '') return undefined;

  let unresolved = false;
  const rendered = template.replace(
    URL_PLACEHOLDER,
    (_match, name: string): string => {
      const value = labels[name];
      if (value === undefined) {
        unresolved = true;
        return '';
      }
      return encodeURIComponent(value);
    },
  );

  return unresolved ? undefined : rendered;
}

/** `{{label}}` / `{{ label }}` — the placeholder syntax in a URL template. */
const URL_PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * The rule name embedded in a dedupe key — `queue_backlog{queue="sms"}` →
 * `queue_backlog`. Inverse of {@link alertDedupeKey}'s prefix.
 */
export function ruleNameOf(dedupeKey: string): string {
  const brace = dedupeKey.indexOf('{');
  return brace === -1 ? dedupeKey : dedupeKey.slice(0, brace);
}

/**
 * The notification handed to a delivery channel. This is what gets serialized
 * into the BullMQ job payload, so it must stay JSON-safe: no Date, no class
 * instances, no Map.
 */
export interface AlertNotification {
  dedupeKey: string;
  /**
   * Short quotable id derived from `dedupeKey` — see {@link alertFingerprint}.
   * Stable across the whole lifecycle of an incident and across recurrences.
   */
  fingerprint: string;
  /** Which transition this message announces. */
  state: AlertState;
  rule: string;
  severity: AlertSeverity;
  labels: AlertLabels;
  values: AlertValues;
  title: string;
  summary: string;
  /**
   * Where to look and what to do. Resolved by the evaluator from the rule's
   * templates plus this alert's labels, so the links point at THIS instance.
   */
  links: AlertLinks;
  /** Which build and which instance produced this. See {@link AlertSource}. */
  source: AlertSource;
  /** Epoch ms of the transition. Rendered as UTC in the message footer. */
  firedAt: number;
  /**
   * How long the alert has been ACTIVE, in ms. Present on a re-notification
   * and on the resolution, so a message can say "still active (3h 25m)" rather
   * than leaving the reader to work it out from timestamps.
   */
  activeForMs?: number;
  /** True when this message resurfaces an alert that was already announced. */
  renotification?: boolean;
}

/**
 * A delivery destination. Implement this and register it in `CHANNELS`
 * (alerting.module.ts) to add Slack, Discord, PagerDuty or a plain webhook.
 *
 * Contract:
 *   • `configured` is checked before anything is enqueued, so an unconfigured
 *     channel costs nothing and never fills the failed set.
 *   • `deliver` MUST throw on failure — that is what triggers the BullMQ
 *     retry/backoff. Swallowing the error silently drops the alert.
 *   • `accepts` lets a channel opt out per alert (e.g. only CRITICAL to
 *     PagerDuty). Default is "everything at or above my minimum severity".
 */
export interface AlertChannel {
  /** Identifier used in logs and in the delivery job payload. */
  readonly name: string;
  /** Whether this channel has the config it needs to deliver at all. */
  readonly configured: boolean;
  /** Whether this channel wants this particular notification. */
  accepts(notification: AlertNotification): boolean;
  deliver(notification: AlertNotification): Promise<void>;
}

/** Format a duration in ms as `3h 25m` / `45m` / `30s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}
