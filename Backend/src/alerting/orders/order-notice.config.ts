import type { ConfigService } from '@nestjs/config';
import { boolEnv } from '../../ops/ops.config';
import { resolveAlertingConfig, trimTrailingSlash } from '../alerting.config';

/**
 * Where order notices go, resolved from the environment in one place.
 *
 *   ORDER_TELEGRAM_NOTIFY   on unless set to anything but `true` (e.g. `false`).
 *   ORDER_TELEGRAM_CHAT_ID  the operators' chat. Falls back to ALERT_TELEGRAM_CHAT_ID, so
 *                           orders reach the chat the alerts already reach with no new
 *                           setting; set it to send orders somewhere else.
 *   bot token               the alerts' own: ALERT_TELEGRAM_BOT_TOKEN, else
 *                           TELEGRAM_BOT_TOKEN (the seller bot, send-only here).
 *   ADMIN_PANEL_URL         the admin panel's base, as the invite e-mails already use it
 *                           (`<base>/accept-invite`). The notice links `<base>/orders/<id>`;
 *                           with it unset there is no link.
 */
export interface OrderNoticeConfig {
  enabled: boolean;
  botToken: string;
  chatId: string;
  /** No trailing slash. Empty: no link in the message. */
  adminPanelUrl: string;
  /** NODE_ENV when it is not `production` (e.g. `staging`), shown in the header. */
  environmentTag: string;
}

/**
 * Delivery attempts for one notice, and the base of their exponential backoff: 10 s,
 * 20 s, 40 s … for about 85 minutes in all. Longer than an alert's budget on purpose:
 * an order nobody hears of is not taken up, while a still-firing alert is sent again.
 */
export const ORDER_NOTICE_ATTEMPTS = 10;
export const ORDER_NOTICE_BACKOFF_MS = 10_000;

export function resolveOrderNoticeConfig(
  config: Pick<ConfigService, 'get'>,
): OrderNoticeConfig {
  const alerting = resolveAlertingConfig(config);
  const nodeEnv = config.get<string>('NODE_ENV')?.trim() ?? '';
  return {
    enabled: boolEnv(config.get<string>('ORDER_TELEGRAM_NOTIFY'), true),
    botToken: alerting.telegramBotToken,
    chatId:
      config.get<string>('ORDER_TELEGRAM_CHAT_ID')?.trim() ||
      alerting.telegramChatId,
    adminPanelUrl: trimTrailingSlash(config.get<string>('ADMIN_PANEL_URL')),
    environmentTag: nodeEnv !== '' && nodeEnv !== 'production' ? nodeEnv : '',
  };
}
