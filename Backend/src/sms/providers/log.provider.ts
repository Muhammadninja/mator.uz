import { Logger } from '@nestjs/common';
import { SmsProvider } from '../sms-provider.interface';

/** Dev/unconfigured fallback — logs instead of sending so flows never block. */
export class LogSmsProvider implements SmsProvider {
  readonly name = 'log';
  private readonly logger = new Logger('LogSmsProvider');

  send(toE164: string, text: string): Promise<void> {
    this.logger.warn(`[SMS DISABLED] -> ${toE164}: ${text}`);
    return Promise.resolve();
  }
}
