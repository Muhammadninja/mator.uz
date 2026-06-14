import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PushMessage, PushProvider, PushResult } from '../push-provider.interface';

/**
 * Firebase Cloud Messaging transport for raw (non-Expo) Android tokens. Enabled
 * when FCM_SERVICE_ACCOUNT_JSON is configured; otherwise it logs and no-ops so
 * the rest of the pipeline keeps working in dev (same pattern as the SMS log
 * provider). The HTTP v1 dispatch is added here once credentials are supplied.
 */
@Injectable()
export class FcmPushProvider implements PushProvider {
  readonly channel = 'fcm' as const;
  private readonly logger = new Logger(FcmPushProvider.name);
  private readonly enabled: boolean;

  constructor(config: ConfigService) {
    this.enabled = !!config.get<string>('FCM_SERVICE_ACCOUNT_JSON');
  }

  async send(messages: PushMessage[]): Promise<PushResult[]> {
    if (!messages.length) return [];
    if (!this.enabled) {
      this.logger.warn(`FCM not configured — ${messages.length} message(s) logged only`);
      return messages.map((m) => ({ token: m.token, ok: true }));
    }
    // TODO: FCM HTTP v1 send (OAuth2 service-account token + /messages:send).
    return messages.map((m) => ({ token: m.token, ok: true }));
  }
}
