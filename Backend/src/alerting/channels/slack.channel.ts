import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  linkEntries,
  renderHeader,
  renderLabels,
  renderDurationLine,
  valueLines,
} from '../alert-message';
import { resolveAlertingConfig } from '../alerting.config';
import {
  ALERT_STATE,
  AlertSeverity,
  severityName,
  type AlertNotification,
} from '../alerting.types';
import { WebhookAlertChannel } from './webhook.channel';

/**
 * Delivers alerts to a Slack incoming webhook.
 *
 * Uses Block Kit rather than a plain `text` message: values render as a
 * two-column field grid, which is what makes "waiting 186 / threshold 100"
 * scannable on a phone. `text` is still populated as the notification fallback —
 * Slack shows it in the push preview and in clients that cannot render blocks,
 * and omitting it produces a notification that says only "New message".
 *
 * Everything else (severity gate, timeout, retry-on-throw) comes from
 * WebhookAlertChannel.
 */
@Injectable()
export class SlackAlertChannel extends WebhookAlertChannel {
  readonly name = 'slack';

  private readonly environmentLabel: string;

  constructor(config: ConfigService) {
    const resolved = resolveAlertingConfig(config);
    super(
      resolved.slackWebhookUrl,
      resolved.slackMinSeverity,
      resolved.webhookTimeoutMs,
    );
    this.environmentLabel = resolved.environmentLabel;
  }

  protected buildPayload(
    notification: AlertNotification,
  ): Record<string, unknown> {
    const header = renderHeader(notification, this.environmentLabel);
    const body =
      notification.state === ALERT_STATE.RESOLVED
        ? `${notification.summary} has returned to normal.`
        : notification.title;

    const blocks: Record<string, unknown>[] = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*${header}*\n${body}` },
      },
    ];

    const duration = renderDurationLine(notification);
    if (duration !== null) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `_${duration}_` }],
      });
    }

    const fields = valueLines(notification.values).map(([label, value]) => ({
      type: 'mrkdwn',
      text: `*${label}*\n${value}`,
    }));
    if (fields.length > 0) {
      // Slack caps a section at 10 fields; anything beyond is dropped silently
      // by their API, so it is truncated here where it is visible.
      blocks.push({
        type: 'section',
        fields: fields.slice(0, SLACK_MAX_FIELDS),
      });
    }

    // Links as an actions block — real buttons, which is what makes them
    // tappable on a phone during an incident rather than a URL to long-press.
    const links = linkEntries(notification);
    if (links.length > 0) {
      blocks.push({
        type: 'actions',
        elements: links.map(([label, url]) => ({
          type: 'button',
          text: { type: 'plain_text', text: label },
          url,
        })),
      });
    }

    const labels = renderLabels(notification);
    if (labels !== null) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: labels }],
      });
    }

    return {
      // Fallback text for push notifications and non-block clients.
      text: `${header} — ${body}`,
      blocks,
      attachments: [
        {
          color: SLACK_COLORS[notification.severity] ?? SLACK_COLOR_DEFAULT,
          // An empty attachment purely to draw the coloured severity bar.
          blocks: [],
          fallback: severityName(notification.severity),
        },
      ],
    };
  }
}

/** Slack's attachment colour bar, by severity. */
const SLACK_COLORS: Readonly<Record<AlertSeverity, string>> = {
  [AlertSeverity.INFO]: '#3b82f6',
  [AlertSeverity.WARNING]: '#eab308',
  [AlertSeverity.ERROR]: '#ef4444',
  [AlertSeverity.CRITICAL]: '#b91c1c',
};

const SLACK_COLOR_DEFAULT = '#eab308';

/** Slack rejects a section with more than 10 fields. */
const SLACK_MAX_FIELDS = 10;
