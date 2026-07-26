import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  linkEntries,
  renderDurationLine,
  renderHeader,
  renderLabels,
  valueLines,
} from '../alert-message';
import { resolveAlertingConfig } from '../alerting.config';
import {
  ALERT_STATE,
  AlertSeverity,
  type AlertNotification,
} from '../alerting.types';
import { WebhookAlertChannel } from './webhook.channel';

/**
 * Delivers alerts to a Discord webhook.
 *
 * Uses an embed rather than plain content: the coloured left border carries
 * severity at a glance, and `inline: true` fields give the same scannable grid
 * Slack gets. Discord's colour is a decimal integer, not a hex string.
 */
@Injectable()
export class DiscordAlertChannel extends WebhookAlertChannel {
  readonly name = 'discord';

  private readonly environmentLabel: string;

  constructor(config: ConfigService) {
    const resolved = resolveAlertingConfig(config);
    super(
      resolved.discordWebhookUrl,
      resolved.discordMinSeverity,
      resolved.webhookTimeoutMs,
    );
    this.environmentLabel = resolved.environmentLabel;
  }

  protected buildPayload(
    notification: AlertNotification,
  ): Record<string, unknown> {
    const description: string[] = [
      notification.state === ALERT_STATE.RESOLVED
        ? `${notification.summary} has returned to normal.`
        : `**${notification.title}**`,
    ];

    const duration = renderDurationLine(notification);
    if (duration !== null) description.push(`*${duration}*`);

    const fields = valueLines(notification.values)
      // Discord caps an embed at 25 fields.
      .slice(0, DISCORD_MAX_FIELDS)
      .map(([label, value]) => ({ name: label, value, inline: true }));

    // Links as full-width markdown fields rather than inline ones: a URL in an
    // inline column wraps into unreadable fragments.
    for (const [label, url] of linkEntries(notification)) {
      fields.push({ name: label, value: `[Open](${url})`, inline: false });
    }

    const labels = renderLabels(notification);

    return {
      embeds: [
        {
          title: renderHeader(notification, this.environmentLabel),
          description: description.join('\n'),
          color: DISCORD_COLORS[notification.severity] ?? DISCORD_COLOR_DEFAULT,
          fields,
          ...(labels !== null ? { footer: { text: labels } } : {}),
          timestamp: new Date(notification.firedAt).toISOString(),
        },
      ],
    };
  }
}

/** Discord embed colours (decimal), mirroring the Slack palette. */
const DISCORD_COLORS: Readonly<Record<AlertSeverity, number>> = {
  [AlertSeverity.INFO]: 0x3b82f6,
  [AlertSeverity.WARNING]: 0xeab308,
  [AlertSeverity.ERROR]: 0xef4444,
  [AlertSeverity.CRITICAL]: 0xb91c1c,
};

const DISCORD_COLOR_DEFAULT = 0xeab308;

/** Discord rejects an embed with more than 25 fields. */
const DISCORD_MAX_FIELDS = 25;
