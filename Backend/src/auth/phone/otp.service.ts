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

const OTP_LENGTH = 6;
const OTP_TTL_MS = 5 * 60 * 1000; // 5 min
const RESEND_COOLDOWN_S = 60;
const MAX_PER_HOUR = 5; // per MSISDN
const MAX_ATTEMPTS = 5; // verify attempts per request

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

  /** Create + send a new OTP for a phone number (AuthPhoneEntryScreen). */
  async request(phoneE164: string, channel: OtpChannel = OtpChannel.SMS): Promise<OtpIssued> {
    await this.enforceHourlyCeiling(phoneE164);

    const code = this.generateCode();
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);
    const record = await this.prisma.phoneOtpRequest.create({
      data: {
        id: prefixedId(IdPrefix.OTP),
        phoneE164,
        codeHash: this.hash(code),
        channel,
        expiresAt,
      },
    });

    const devOtpCode = await this.dispatch(phoneE164, code);
    this.logger.log(`OTP issued ${record.id} for ${phoneE164}`);
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
   */
  async verify(requestId: string, phoneE164: string, code: string): Promise<void> {
    const record = await this.prisma.phoneOtpRequest.findUnique({ where: { id: requestId } });
    if (!record || record.phoneE164 !== phoneE164 || record.consumedAt) {
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

    await this.prisma.phoneOtpRequest.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    });
  }
}
