import { Logger } from '@nestjs/common';
import { SmsProvider, SmsSendResult, EMPTY_SMS_RESULT } from '../sms-provider.interface';

/** Dev/unconfigured fallback — logs instead of sending so flows never block. */
export class LogSmsProvider implements SmsProvider {
  readonly name = 'log';
  private readonly logger = new Logger('LogSmsProvider');

  send(toE164: string, text: string): Promise<SmsSendResult> {
    this.logger.warn(`[SMS DISABLED] -> ${toE164}: ${text}`);
    // Nothing was actually delivered, so there is no provider metadata.
    return Promise.resolve(EMPTY_SMS_RESULT);
  }
}
