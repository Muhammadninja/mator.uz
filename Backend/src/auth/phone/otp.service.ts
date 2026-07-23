import {
  Injectable,
  Logger,
  BadRequestException,
  UnauthorizedException,
  GoneException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomInt } from 'crypto';
import { OtpChannel } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SmsService } from '../../sms/sms.service';
import { prefixedId, IdPrefix } from '../../common/ulid.util';
import { maskPhone } from '../../common/pii.util';

const OTP_LENGTH = 6;
const OTP_TTL_MS = 5 * 60 * 1000; // 5 min
const RESEND_COOLDOWN_S = 60;
const MAX_PER_HOUR = 5; // per MSISDN
const MAX_ATTEMPTS = 5; // verify attempts per request

/**
 * OTP purposes. `login` is the default (phone sign-in/registration) and matches
 * the schema default, so existing rows and callers are unchanged. `phone_change`
 * isolates the "change my number" flow: a code minted for one purpose can never
 * be consumed by the other (see {@link OtpService.verify}).
 */
export const OtpPurpose = {
  LOGIN: 'login',
  PHONE_CHANGE: 'phone_change',
} as const;
export type OtpPurpose = (typeof OtpPurpose)[keyof typeof OtpPurpose];

export interface OtpIssued {
  requestId: string;
  expiresAt: Date;
  resendAfterSeconds: number;
  otpLength: number;
  channel: OtpChannel;
  /**
   * Only populated when AUTH_DEV_MODE is enabled: the plaintext OTP so the
   * frontend can complete phone auth without an SMS provider. Never set in
   * production.
   */
  devOtpCode?: string;
}

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly devMode: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsService,
    private readonly config: ConfigService,
  ) {
    this.devMode = this.config.get<string>('AUTH_DEV_MODE') === 'true';
    if (this.devMode) {
      this.logger.warn('AUTH_DEV_MODE is ON — OTPs are logged and returned in the API, SMS is skipped. Do NOT enable in production.');
    }
  }

  private hash(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  private generateCode(): string {
    return randomInt(0, 10 ** OTP_LENGTH).toString().padStart(OTP_LENGTH, '0');
  }

  private async enforceHourlyCeiling(phoneE164: string): Promise<void> {
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const count = await this.prisma.phoneOtpRequest.count({
      where: { phoneE164, createdAt: { gte: since } },
    });
    if (count >= MAX_PER_HOUR) {
      throw new HttpException(
        'Too many OTP requests. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async deliver(phoneE164: string, code: string): Promise<void> {
    await this.sms.sendSms(
      phoneE164,
      `Mator: tasdiqlash kodingiz ${code}. Hech kimga bermang. Amal qilish muddati 5 daqiqa.`,
    );
  }

  /**
   * Route a freshly generated OTP to the user. In dev mode the SMS provider is
   * skipped entirely — the code is logged and returned to the caller so the
   * frontend can complete auth without a provider. In every other case this is
   * a straight pass-through to {@link deliver}, so production is unchanged.
   * Returns the plaintext code only in dev mode; `undefined` otherwise.
   */
  private async dispatch(phoneE164: string, code: string): Promise<string | undefined> {
    if (this.devMode) {
      this.logger.warn(`[AUTH_DEV_MODE] OTP for ${phoneE164}: ${code} (SMS skipped)`);
      return code;
    }
    await this.deliver(phoneE164, code);
    return undefined;
  }

  /**
   * Create + send a new OTP for a phone number (AuthPhoneEntryScreen).
   *
   * `purpose` defaults to `login` (the schema default), so the phone sign-in
   * flow is unchanged. Other flows (e.g. changing the account phone number) pass
   * a distinct purpose so their codes are namespaced and can only be verified by
   * the matching flow.
   */
  async request(
    phoneE164: string,
    channel: OtpChannel = OtpChannel.SMS,
    purpose: OtpPurpose = OtpPurpose.LOGIN,
  ): Promise<OtpIssued> {
    await this.enforceHourlyCeiling(phoneE164);

    const code = this.generateCode();
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);
    const record = await this.prisma.phoneOtpRequest.create({
      data: {
        id: prefixedId(IdPrefix.OTP),
        phoneE164,
        codeHash: this.hash(code),
        channel,
        purpose,
        expiresAt,
      },
    });

    const devOtpCode = await this.dispatch(phoneE164, code);
    this.logger.log(`OTP issued ${record.id} for ${maskPhone(phoneE164)}`);
    return {
      requestId: record.id,
      expiresAt,
      resendAfterSeconds: RESEND_COOLDOWN_S,
      otpLength: OTP_LENGTH,
      channel,
      devOtpCode,
    };
  }

  /** Resend using the same request_id (AuthOtpVerifyScreen). */
  async resend(requestId: string): Promise<OtpIssued> {
    const record = await this.prisma.phoneOtpRequest.findUnique({ where: { id: requestId } });
    if (!record || record.consumedAt) {
      throw new BadRequestException('Invalid or already-used OTP request');
    }

    const sinceLast = (Date.now() - record.lastSentAt.getTime()) / 1000;
    if (sinceLast < RESEND_COOLDOWN_S) {
      throw new HttpException(
        `Please wait ${Math.ceil(RESEND_COOLDOWN_S - sinceLast)}s before requesting a new code.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    await this.enforceHourlyCeiling(record.phoneE164);

    const code = this.generateCode();
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);
    await this.prisma.phoneOtpRequest.update({
      where: { id: record.id },
      data: {
        codeHash: this.hash(code),
        expiresAt,
        lastSentAt: new Date(),
        attempts: 0,
        resendCount: { increment: 1 },
      },
    });

    const devOtpCode = await this.dispatch(record.phoneE164, code);
    return {
      requestId: record.id,
      expiresAt,
      resendAfterSeconds: RESEND_COOLDOWN_S,
      otpLength: OTP_LENGTH,
      channel: record.channel,
      devOtpCode,
    };
  }

  /**
   * Validate a code for a request. On success the request is consumed (single
   * use). Throws on every failure path with a specific status.
   *
   * When `purpose` is provided the stored request must have been minted for the
   * same purpose, so a code issued for one flow (e.g. login) can never be
   * redeemed by another (e.g. phone change). Omitting it preserves the original
   * behaviour for existing callers.
   */
  async verify(
    requestId: string,
    phoneE164: string,
    code: string,
    purpose?: OtpPurpose,
  ): Promise<void> {
    const record = await this.prisma.phoneOtpRequest.findUnique({ where: { id: requestId } });
    if (
      !record ||
      record.phoneE164 !== phoneE164 ||
      record.consumedAt ||
      (purpose !== undefined && record.purpose !== purpose)
    ) {
      throw new BadRequestException('Invalid or already-used verification request');
    }
    if (record.expiresAt < new Date()) {
      throw new GoneException('Verification code has expired. Please request a new one.');
    }
    if (record.attempts >= MAX_ATTEMPTS) {
      throw new HttpException(
        'Too many incorrect attempts. Please request a new code.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (this.hash(code) !== record.codeHash) {
      await this.prisma.phoneOtpRequest.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
      });
      throw new UnauthorizedException('Incorrect verification code');
    }

    // Atomic single-use consume: the `consumedAt: null` guard means only the
    // FIRST of two concurrent verifications of the same code wins (updates 1
    // row); the loser updates 0 rows and is rejected. Closes the read-then-write
    // race where a code could otherwise be redeemed twice (double-submit).
    const consumed = await this.prisma.phoneOtpRequest.updateMany({
      where: { id: record.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count === 0) {
      throw new BadRequestException('Invalid or already-used verification request');
    }
  }

  /**
   * Verify the most recent still-active OTP for a `(phone, purpose)` pair,
   * without the caller having to carry a request_id. Used by flows whose
   * confirm step only knows the phone + code (e.g. changing the account phone
   * number). Resolves the newest unconsumed, unexpired request, then delegates
   * to {@link verify} so every security rule (purpose isolation, attempt
   * ceiling, single-use consume) is applied exactly once.
   */
  async verifyLatestForPhone(phoneE164: string, code: string, purpose: OtpPurpose): Promise<void> {
    const record = await this.prisma.phoneOtpRequest.findFirst({
      where: {
        phoneE164,
        purpose,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!record) {
      throw new BadRequestException('No active verification request for this phone. Please request a new code.');
    }
    await this.verify(record.id, phoneE164, code, purpose);
  }
}
