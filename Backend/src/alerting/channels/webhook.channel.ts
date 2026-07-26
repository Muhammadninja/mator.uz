import { Logger } from '@nestjs/common';
import axios, { type AxiosRequestConfig } from 'axios';
import {
  AlertSeverity,
  severityName,
  type AlertChannel,
  type AlertNotification,
} from '../alerting.types';

/**
 * Shared behaviour for every HTTP-webhook-based channel (Slack, Discord, and
 * the generic JSON sink).
 *
 * Subclasses supply only two things: the URL and how to shape the request body.
 * Everything else — the severity gate, the timeout, error normalisation, and
 * the "throw so BullMQ retries" contract — lives here once, which is what keeps
 * adding a fourth destination to roughly twenty lines.
 *
 * Uses `axios`, already a dependency and already the app's outbound HTTP client
 * (see the SMS providers), rather than introducing a second one.
 */
export abstract class WebhookAlertChannel implements AlertChannel {
  abstract readonly name: string;

  protected readonly logger = new Logger(this.constructor.name);

  constructor(
    /** Destination URL. Empty string disables the channel entirely. */
    protected readonly url: string,
    /** Minimum severity this channel delivers. */
    protected readonly minSeverity: AlertSeverity,
    /** Per-request timeout in ms. */
    protected readonly timeoutMs: number,
  ) {}

  /** A channel with no URL configured is inert and never enqueued for. */
  get configured(): boolean {
    return this.url !== '';
  }

  /**
   * Severity gate. Overridable, but the default — "at or above my minimum" — is
   * what makes `ALERT_SLACK_MIN_SEVERITY=ERROR` work with no code change.
   */
  accepts(notification: AlertNotification): boolean {
    return notification.severity >= this.minSeverity;
  }

  /** POST the shaped body. Throws on failure so BullMQ applies its backoff. */
  async deliver(notification: AlertNotification): Promise<void> {
    const body = this.buildPayload(notification);

    try {
      await axios.post(this.url, body, this.requestConfig());
    } catch (err) {
      // Normalise into a message that names the channel and the HTTP status —
      // "Slack webhook failed: 404" is actionable, a raw axios dump is not.
      throw new Error(`${this.name} webhook failed: ${describeHttpError(err)}`);
    }
  }

  /** The request body for this destination. */
  protected abstract buildPayload(
    notification: AlertNotification,
  ): Record<string, unknown>;

  /** Axios options. Overridden by the generic channel to add an auth header. */
  protected requestConfig(): AxiosRequestConfig {
    return {
      timeout: this.timeoutMs,
      headers: { 'Content-Type': 'application/json' },
    };
  }
}

/**
 * Turn an unknown thrown value into a short, useful description. Prefers the
 * HTTP status and the provider's own error body, both of which are what an
 * operator needs to tell "misconfigured URL" from "rate limited".
 */
export function describeHttpError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    // `response.data` is `any` by axios's typing; narrow it before use rather
    // than letting an unknown shape flow into the message.
    const data: unknown = err.response?.data;
    const detail =
      typeof data === 'string'
        ? data.slice(0, MAX_ERROR_CHARS)
        : data !== undefined && data !== null
          ? JSON.stringify(data).slice(0, MAX_ERROR_CHARS)
          : err.message;
    return status !== undefined ? `HTTP ${status} — ${detail}` : detail;
  }
  return err instanceof Error ? err.message : String(err);
}

const MAX_ERROR_CHARS = 200;

/**
 * The JSON body every alert carries into a generic webhook. Deliberately
 * Prometheus-shaped (`status` / `labels` / `values`) so an existing
 * Alertmanager-compatible receiver, or a PagerDuty Events proxy, can consume it
 * with no translation layer.
 */
export function genericAlertBody(
  notification: AlertNotification,
): Record<string, unknown> {
  return {
    status: notification.state === 'RESOLVED' ? 'resolved' : 'firing',
    rule: notification.rule,
    severity: severityName(notification.severity),
    labels: notification.labels,
    values: notification.values,
    title: notification.title,
    summary: notification.summary,
    dedupeKey: notification.dedupeKey,
    // The stable short id. A receiver (PagerDuty, an incident tracker) can use
    // it as its own dedup key and it will agree with what the chat message and
    // the logs show for the same incident.
    fingerprint: notification.fingerprint,
    source: notification.source,
    firedAt: new Date(notification.firedAt).toISOString(),
    ...(notification.activeForMs !== undefined
      ? { activeForMs: notification.activeForMs }
      : {}),
  };
}
