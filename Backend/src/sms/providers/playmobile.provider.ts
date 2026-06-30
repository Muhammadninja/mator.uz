import { Logger } from '@nestjs/common';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { SmsProvider } from '../sms-provider.interface';

interface PlaymobileConfig {
  baseUrl: string; // https://send.smsxabar.uz/broker-api
  login: string;
  password: string;
  originator: string;
}

/**
 * Playmobile (smsxabar) broker API. HTTP Basic auth; one message per request.
 */
export class PlaymobileSmsProvider implements SmsProvider {
  readonly name = 'playmobile';
  private readonly logger = new Logger('PlaymobileSmsProvider');

  constructor(private readonly cfg: PlaymobileConfig) {}

  async send(toE164: string, text: string): Promise<void> {
    const recipient = toE164.replace(/\D/g, '');
    const body = {
      messages: [
        {
          recipient,
          'message-id': randomUUID(),
          sms: { originator: this.cfg.originator, content: { text } },
        },
      ],
    };

    try {
      await axios.post(`${this.cfg.baseUrl}/send`, body, {
        auth: { username: this.cfg.login, password: this.cfg.password },
        timeout: 10_000,
      });
    } catch (err) {
      this.logger.error(`Playmobile send failed: ${(err as Error).message}`);
      throw err;
    }
  }
}
