import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SmsProvider } from './sms-provider.interface';
import { LogSmsProvider } from './providers/log.provider';
import { EskizSmsProvider } from './providers/eskiz.provider';
import { PlaymobileSmsProvider } from './providers/playmobile.provider';

/**
 * Selects the active SMS provider from SMS_PROVIDER (eskiz | playmobile | log)
 * and exposes a single send() to the rest of the app. Falls back to the log
 * provider when the chosen aggregator is missing credentials, so OTP flows
 * never hard-fail in dev.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private readonly provider: SmsProvider;

  constructor(private readonly config: ConfigService) {
    this.provider = this.resolveProvider();
    this.logger.log(`SMS provider: ${this.provider.name}`);
  }

  private resolveProvider(): SmsProvider {
    const choice = (this.config.get<string>('SMS_PROVIDER') ?? 'log').toLowerCase();

    if (choice === 'eskiz') {
      const email = this.config.get<string>('ESKIZ_EMAIL');
      const password = this.config.get<string>('ESKIZ_PASSWORD');
      if (email && password) {
        return new EskizSmsProvider({
          baseUrl: this.config.get<string>('ESKIZ_BASE_URL') ?? 'https://notify.eskiz.uz/api',
          email,
          password,
          from: this.config.get<string>('ESKIZ_FROM'),
        });
      }
      this.logger.warn('SMS_PROVIDER=eskiz but credentials missing — falling back to log');
    }

    if (choice === 'playmobile') {
      const login = this.config.get<string>('PLAYMOBILE_LOGIN');
      const password = this.config.get<string>('PLAYMOBILE_PASSWORD');
      if (login && password) {
        return new PlaymobileSmsProvider({
          baseUrl:
            this.config.get<string>('PLAYMOBILE_BASE_URL') ?? 'https://send.smsxabar.uz/broker-api',
          login,
          password,
          originator: this.config.get<string>('PLAYMOBILE_ORIGINATOR') ?? '3700',
        });
      }
      this.logger.warn('SMS_PROVIDER=playmobile but credentials missing — falling back to log');
    }

    return new LogSmsProvider();
  }

  async sendSms(toE164: string, text: string): Promise<void> {
    await this.provider.send(toE164, text);
  }
}
