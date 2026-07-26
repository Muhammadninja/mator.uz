import {
  ALERT_STATE,
  AlertSeverity,
  formatDuration,
  severityName,
  type AlertNotification,
  type AlertValues,
} from './alerting.types';

/**
 * Renders an alert into message text.
 *
 * Pure and transport-free: no bot, no config service, no I/O. That is what lets
 * the exact wire format be asserted in a unit test, which matters because the
 * format IS the product here — an operator reads this at 3am on a phone.
 *
 * The Telegram renderer emits HTML (`parse_mode: 'HTML'`) rather than Markdown:
 * alert values include provider error strings, which routinely contain `_`, `*`
 * and `[`. Markdown would either mangle them or fail the send outright, whereas
 * HTML needs only three characters escaped (see {@link escapeHtml}). The plain
 * renderer is shared by Slack and Discord, which take their own markup.
 */

/** Severity → the emoji leading the header. */
const SEVERITY_EMOJI: Readonly<Record<AlertSeverity, string>> = {
  [AlertSeverity.INFO]: '🔵',
  [AlertSeverity.WARNING]: '🟡',
  [AlertSeverity.ERROR]: '🔴',
  [AlertSeverity.CRITICAL]: '🚨',
};

/** The emoji a resolution message leads with, regardless of severity. */
const RESOLVED_EMOJI = '✅';

/** Emoji for a severity, falling back for an out-of-range value. */
export function severityEmoji(severity: AlertSeverity): string {
  return SEVERITY_EMOJI[severity] ?? '🟡';
}

/**
 * The header line: `🟡 Warning · Mator Production`.
 *
 * Severity is named as well as coloured — emoji alone is ambiguous in a
 * notification preview and unreadable to a screen reader.
 */
export function renderHeader(
  notification: AlertNotification,
  environmentLabel: string,
): string {
  if (notification.state === ALERT_STATE.RESOLVED) {
    return `${RESOLVED_EMOJI} Resolved · Mator ${environmentLabel}`;
  }
  const label = titleCaseSeverity(notification.severity);
  return `${severityEmoji(notification.severity)} ${label} · Mator ${environmentLabel}`;
}

/**
 * The `still active — 3h 25m` suffix on a re-notification.
 *
 * This is the whole point of re-notification: a bare repeat of the original
 * message reads as a duplicate and gets ignored, whereas a stated duration
 * reads as an escalating incident.
 */
export function renderDurationLine(
  notification: AlertNotification,
): string | null {
  if (notification.activeForMs === undefined) return null;
  const duration = formatDuration(notification.activeForMs);

  return notification.state === ALERT_STATE.RESOLVED
    ? `Was active for: ${duration}`
    : `Still active — ${duration}`;
}

/** `Label: value` rows from the values map, in insertion order. */
export function valueLines(values: AlertValues): [string, string][] {
  return Object.entries(values).map(([key, value]) => [
    humanizeKey(key),
    String(value),
  ]);
}

/**
 * Render for Telegram (HTML parse mode).
 *
 * ACTIVE:
 *   🚨 <b>Critical · Mator Production</b>
 *
 *   <b>Image Queue Backlog</b>
 *   <i>Still active — 3h 25m</i>
 *
 *   Waiting jobs: <b>186</b>
 *   Threshold: <b>100</b>
 *
 *   Queue: image-processing
 *
 *   Time:
 *   2026-07-26 14:31 UTC
 */
export function renderAlertMessage(
  notification: AlertNotification,
  environmentLabel: string,
): string {
  const lines: string[] = [
    `<b>${escapeHtml(renderHeader(notification, environmentLabel))}</b>`,
    '',
  ];

  if (notification.state === ALERT_STATE.RESOLVED) {
    lines.push(
      `${escapeHtml(capitalize(notification.summary))} has returned to normal.`,
    );
  } else {
    // The fingerprint sits on the title line so it is visible in a collapsed
    // notification preview — that is where it does its job, letting someone say
    // "look at A7F91B" without opening the message.
    lines.push(
      `<b>${escapeHtml(notification.title)}</b> ` +
        `<code>[${escapeHtml(notification.fingerprint)}]</code>`,
    );
  }

  const duration = renderDurationLine(notification);
  if (duration !== null) lines.push(`<i>${escapeHtml(duration)}</i>`);

  const values = valueLines(notification.values);
  if (values.length > 0) {
    lines.push(
      '',
      ...values.map(
        ([label, value]) => `${escapeHtml(label)}: <b>${escapeHtml(value)}</b>`,
      ),
    );
  }

  const labels = renderLabels(notification);
  if (labels !== null) lines.push('', `<i>${escapeHtml(labels)}</i>`);

  const source = renderSourceLines(notification);
  if (source.length > 0) {
    lines.push('', ...source.map((line) => `<i>${escapeHtml(line)}</i>`));
  }

  lines.push('', 'Time:', formatUtc(notification.firedAt));

  return lines.join('\n');
}

/**
 * Render as plain text with no markup — used by Slack and Discord, which wrap
 * it in their own formatting.
 */
export function renderPlainMessage(
  notification: AlertNotification,
  environmentLabel: string,
): string {
  const lines: string[] = [renderHeader(notification, environmentLabel), ''];

  lines.push(
    notification.state === ALERT_STATE.RESOLVED
      ? `${capitalize(notification.summary)} has returned to normal.`
      : `${notification.title} [${notification.fingerprint}]`,
  );

  const duration = renderDurationLine(notification);
  if (duration !== null) lines.push(duration);

  const values = valueLines(notification.values);
  if (values.length > 0) {
    lines.push('', ...values.map(([label, value]) => `${label}: ${value}`));
  }

  const labels = renderLabels(notification);
  if (labels !== null) lines.push('', labels);

  const source = renderSourceLines(notification);
  if (source.length > 0) lines.push('', ...source);

  lines.push('', `Time: ${formatUtc(notification.firedAt)}`);

  return lines.join('\n');
}

/**
 * The build/host footer, e.g. `Build: v0.0.1 · 81e6fd3` and
 * `Source: backend-02 · worker-3`.
 *
 * ── When it is shown ──
 * On ERROR and above, plus every resolution of one. Not on WARNING: a slow-P95
 * warning does not prompt "which release is this?", and appending four lines of
 * provenance to every routine warning is how a message stops being scannable.
 * The threshold is where the question actually gets asked — right after a
 * deploy, when something broke.
 *
 * Each component is omitted when unknown, so a local run does not print
 * `commit: unknown` noise.
 */
export function renderSourceLines(notification: AlertNotification): string[] {
  if (!includesSource(notification)) return [];

  const { version, commit, host, instance, pid } = notification.source;
  const lines: string[] = [];

  const build = [version && `v${version}`, commit].filter(Boolean).join(' · ');
  if (build !== '') lines.push(`Build: ${build}`);

  // pid disambiguates two instances on one host when PM2 labels are absent.
  const where = [host, instance, pid ? `pid ${pid}` : ''].filter(Boolean);
  if (where.length > 0) lines.push(`Source: ${where.join(' · ')}`);

  return lines;
}

/**
 * Whether this notification is serious enough to carry build provenance.
 * A resolution inherits the decision from the severity it is resolving, which
 * it no longer carries — so resolutions always include it, since knowing which
 * build recovered is exactly as useful as knowing which one broke.
 */
function includesSource(notification: AlertNotification): boolean {
  return (
    notification.state === ALERT_STATE.RESOLVED ||
    notification.severity >= SOURCE_MIN_SEVERITY
  );
}

/** Severity at or above which build/host provenance is appended. */
const SOURCE_MIN_SEVERITY = AlertSeverity.ERROR;

/**
 * The label line, e.g. `queue=image-processing · environment=production`.
 *
 * Rendered last and de-emphasised: labels are identity/grouping metadata, not
 * the thing an operator reads first. Returns null when there is nothing to show.
 */
export function renderLabels(notification: AlertNotification): string | null {
  const entries = Object.entries(notification.labels);
  if (entries.length === 0) return null;
  return entries.map(([key, value]) => `${key}=${value}`).join(' · ');
}

/**
 * `2026-07-26 14:31 UTC`.
 *
 * Always UTC, never the server's local zone: an alert timestamp is correlated
 * against logs and Grafana, both of which are UTC here, and a message that
 * silently switches zone with the host's TZ is worse than no timestamp.
 */
export function formatUtc(epochMs: number): string {
  const iso = new Date(epochMs).toISOString();
  // '2026-07-26T14:31:07.123Z' → '2026-07-26 14:31 UTC'
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * Escape the three characters that are special in Telegram's HTML parse mode.
 * Applied to EVERY interpolated value — titles, labels and provider error
 * strings all originate outside this file.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** `waitingJobs` / `waiting_jobs` → `Waiting jobs`. */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return capitalize(spaced);
}

/** `CRITICAL` → `Critical`. */
export function titleCaseSeverity(severity: AlertSeverity): string {
  return capitalize(severityName(severity).toLowerCase());
}

/** Uppercase the first character, leaving the rest untouched. */
function capitalize(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}
