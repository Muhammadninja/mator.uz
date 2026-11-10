import { Logger } from '@nestjs/common';
import { SmsProvider, SmsSendResult, EMPTY_SMS_RESULT } from '../sms-provider.interface';
import { maskPhone } from '../../common/pii.util';

/**
 * Local development and tests only: records that a message would have been sent
 * and sends nothing. SmsService refuses to select it in production.
 *
 * The text is never logged, in any environment: it may be a one-time code, and a
 * log file is not a place for one. To complete phone auth without a provider,
 * use AUTH_DEV_MODE, which returns the code in the API response instead.
 */
export class LogSmsProvider implements SmsProvider {
  readonly name = 'log';
  private readonly logger = new Logger('LogSmsProvider');

  send(toE164: string, text: string): Promise<SmsSendResult> {
    this.logger.warn(
      `[SMS DISABLED] not sent to ${maskPhone(toE164)} (${text.length} chars)`,
    );
    // Nothing was actually delivered, so there is no provider metadata.
    return Promise.resolve(EMPTY_SMS_RESULT);
  }
}
