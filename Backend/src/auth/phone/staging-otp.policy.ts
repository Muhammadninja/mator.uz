import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'crypto';
import { requestContext } from '../../common/request-context';
import {
  readStagingOtpConfig,
  STAGING_OTP_ENABLED_ENV,
  StagingOtpConfig,
  StagingTester,
} from './staging-otp.config';

/** Constant-time equality over fixed-length digests, so length leaks nothing. */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Who may use staging tester OTP, decided per request. See staging-otp.config.ts
 * for the trust chain. Every refusal is the same 403, so a caller learns neither
 * which testers exist nor which numbers they hold.
 */
@Injectable()
export class StagingOtpPolicy {
  private readonly logger = new Logger(StagingOtpPolicy.name);
  private readonly config: StagingOtpConfig;

  constructor(config: ConfigService) {
    const get = (key: string) => config.get<string>(key);
    // Defence in depth behind the boot-time check, as with AUTH_DEV_MODE.
    if (
      get('NODE_ENV') === 'production' &&
      get(STAGING_OTP_ENABLED_ENV)?.trim().toLowerCase() === 'true'
    ) {
      throw new Error(`${STAGING_OTP_ENABLED_ENV} is forbidden in production.`);
    }
    this.config = readStagingOtpConfig(get);
    if (this.config.enabled) {
      this.logger.warn(
        `Staging tester OTP is ON for ${this.config.testers.size} tester(s): no SMS is sent, ` +
          'codes go to the tester inbox. Never enable outside staging.',
      );
    }
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** The tester the staging proxy vouched for on this request, or null. */
  currentTester(): StagingTester | null {
    if (!this.config.enabled) return null;
    const proxy = requestContext.getStore()?.stagingProxy;
    if (!proxy?.tester || !proxy.auth) return null;
    if (!safeEqual(proxy.auth, this.config.proxySecret)) return null;
    return this.config.testers.get(proxy.tester) ?? null;
  }

  /** The current tester, if this number is one of theirs; otherwise 403. */
  assertMayUse(phoneE164: string): StagingTester {
    const tester = this.currentTester();
    if (!tester || !tester.phones.includes(phoneE164)) {
      throw new ForbiddenException({
        code: 'STAGING_OTP_NOT_ALLOWED',
        message: 'This number is not enabled for staging sign-in.',
      });
    }
    return tester;
  }

  /** Where a tester's pending code for one OTP slot is sealed. */
  inboxRef(testerId: string, slot: string): string {
    return `staging:${testerId}:${slot}`;
  }
}
