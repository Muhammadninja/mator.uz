import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SmsProvider } from './sms-provider.interface';
import { LogSmsProvider } from './providers/log.provider';
import { EskizSmsProvider } from './providers/eskiz.provider';
import { PlaymobileSmsProvider } from './providers/playmobile.provider';
import { SayqalSmsProvider } from './providers/sayqal.provider';

/**
 * Selects the active SMS provider from SMS_PROVIDER (eskiz | playmobile | sayqal
 * | log) and exposes a single send() to the rest of the app. Falls back to the
 * log provider when the chosen aggregator is missing credentials, so OTP flows
 * never hard-fail in dev.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private readonly provider: SmsProvider;

  constructor(private readonly config: ConfigService) {
    // [SMS-DIAG] TEMP — prove, at construction time, exactly what the runtime
    // sees. `log` level so it shows under the default prod logger. NEVER logs the
    // secret key, token, headers, body, or OTP codes.
    this.logger.log(
      `[SMS-DIAG] ctor cwd=${process.cwd()} ` +
        `process.env.SMS_PROVIDER=${JSON.stringify(process.env.SMS_PROVIDER)} ` +
        `config.get(SMS_PROVIDER)=${JSON.stringify(this.config.get<string>('SMS_PROVIDER'))} ` +
        `hasSAYQAL_USERNAME=${!!this.config.get<string>('SAYQAL_USERNAME')} ` +
        `SAYQAL_SERVICE_ID=${JSON.stringify(this.config.get<string>('SAYQAL_SERVICE_ID'))}`,
    );

    this.provider = this.resolveProvider();

    // [SMS-DIAG] TEMP — constructor name of the actually-resolved provider.
    this.logger.log(
      `[SMS-DIAG] ctor resolved provider constructor=${this.provider.constructor.name} name=${this.provider.name}`,
    );

    this.logger.log(`SMS provider: ${this.provider.name}`);
  }

  private resolveProvider(): SmsProvider {
    const choice = (this.config.get<string>('SMS_PROVIDER') ?? 'log').toLowerCase();

    // [SMS-DIAG] TEMP — the normalized choice the branch logic keys on.
    this.logger.log(`[SMS-DIAG] resolveProvider choice=${JSON.stringify(choice)}`);

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

    if (choice === 'sayqal') {
      // [SMS-DIAG] TEMP — proof we entered the sayqal branch.
      this.logger.log('[SMS-DIAG] sayqal: entered branch');

      const username = this.config.get<string>('SAYQAL_USERNAME');
      const secretKey = this.config.get<string>('SAYQAL_SECRET_KEY');
      const serviceId = Number(this.config.get<string>('SAYQAL_SERVICE_ID'));

      // [SMS-DIAG] TEMP — presence + parsed serviceId + integer check. Secret is
      // reported as a boolean only; its value is never logged.
      this.logger.log(
        `[SMS-DIAG] sayqal: hasUsername=${!!username} hasSecretKey=${!!secretKey} ` +
          `parsedServiceId=${serviceId} isInteger=${Number.isInteger(serviceId)}`,
      );

      if (username && secretKey && Number.isInteger(serviceId)) {
        // [SMS-DIAG] TEMP — success path: SayqalSmsProvider is being constructed.
        this.logger.log('[SMS-DIAG] sayqal: constructing SayqalSmsProvider');
        return new SayqalSmsProvider({
          baseUrl: this.config.get<string>('SAYQAL_BASE_URL') ?? 'https://routee.sayqal.uz',
          username,
          secretKey,
          serviceId,
          nickname: this.config.get<string>('SAYQAL_NICKNAME'),
        });
      }

      // [SMS-DIAG] TEMP — exactly which guard condition(s) failed.
      const failed = [
        !username && 'SAYQAL_USERNAME missing',
        !secretKey && 'SAYQAL_SECRET_KEY missing',
        !Number.isInteger(serviceId) && 'SAYQAL_SERVICE_ID not an integer',
      ].filter(Boolean);
      this.logger.error(`[SMS-DIAG] sayqal: guard FAILED -> ${failed.join('; ')}`);

      this.logger.warn(
        'SMS_PROVIDER=sayqal but SAYQAL_USERNAME/SAYQAL_SECRET_KEY/SAYQAL_SERVICE_ID missing or invalid — falling back to log',
      );
    }

    // [SMS-DIAG] TEMP — LogSmsProvider is being returned (final fallback).
    this.logger.error(
      `[SMS-DIAG] returning LogSmsProvider (choice=${JSON.stringify(choice)})`,
    );
    return new LogSmsProvider();
  }

  async sendSms(toE164: string, text: string): Promise<void> {
    await this.provider.send(toE164, text);
  }
}
