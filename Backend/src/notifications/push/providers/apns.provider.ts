import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PushMessage, PushProvider, PushResult } from '../push-provider.interface';

/**
 * Apple Push Notification service transport for raw (non-Expo) iOS tokens.
 * Enabled when APNS_KEY_P8 is configured; otherwise it logs and no-ops in dev.
 * The token-based (JWT) HTTP/2 dispatch is added here once credentials exist.
 */
@Injectable()
export class ApnsPushProvider implements PushProvider {
  readonly channel = 'apns' as const;
  private readonly logger = new Logger(ApnsPushProvider.name);
  private readonly enabled: boolean;

  constructor(config: ConfigService) {
    this.enabled = !!config.get<string>('APNS_KEY_P8');
  }

  async send(messages: PushMessage[]): Promise<PushResult[]> {
    if (!messages.length) return [];
    if (!this.enabled) {
      this.logger.warn(`APNS not configured — ${messages.length} message(s) logged only`);
      return messages.map((m) => ({ token: m.token, ok: true }));
    }
    // TODO: APNS token-based HTTP/2 send (ES256 JWT + /3/device/{token}).
    return messages.map((m) => ({ token: m.token, ok: true }));
  }
}
