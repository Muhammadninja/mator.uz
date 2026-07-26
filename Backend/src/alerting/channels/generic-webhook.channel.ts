import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AxiosRequestConfig } from 'axios';
import { resolveAlertingConfig } from '../alerting.config';
import type { AlertNotification } from '../alerting.types';
import { WebhookAlertChannel, genericAlertBody } from './webhook.channel';

/**
 * Delivers alerts as plain JSON to an arbitrary HTTP endpoint.
 *
 * This is the escape hatch: a PagerDuty Events proxy, an internal incident
 * service, an n8n/Zapier hook, or a receiver that already speaks Alertmanager's
 * shape. The body is deliberately Prometheus-like (`status` / `labels` /
 * `values`) so such a receiver needs no translation layer — see
 * {@link genericAlertBody}.
 *
 * Optional bearer/basic auth via ALERT_WEBHOOK_AUTH_HEADER, whose value is sent
 * verbatim as `Authorization`. Kept as an opaque header rather than modelling
 * auth schemes here, because every receiver wants a slightly different one.
 */
@Injectable()
export class GenericWebhookAlertChannel extends WebhookAlertChannel {
  readonly name = 'webhook';

  private readonly authHeader: string;

  constructor(config: ConfigService) {
    const resolved = resolveAlertingConfig(config);
    super(
      resolved.webhookUrl,
      resolved.webhookMinSeverity,
      resolved.webhookTimeoutMs,
    );
    this.authHeader = resolved.webhookAuthHeader;
  }

  protected buildPayload(
    notification: AlertNotification,
  ): Record<string, unknown> {
    return genericAlertBody(notification);
  }

  protected requestConfig(): AxiosRequestConfig {
    const base = super.requestConfig();
    if (this.authHeader === '') return base;

    return {
      ...base,
      headers: { ...base.headers, Authorization: this.authHeader },
    };
  }
}
