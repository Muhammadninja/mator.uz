import {
  Injectable,
  Inject,
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
import { SmsService } from '../../sms/sms.service';
import { prefixedId, IdPrefix } from '../../common/ulid.util';
import { maskPhone } from '../../common/pii.util';
import { RedisService } from '../../redis/redis.service';
import type { RateLimiter } from '../../redis/rate-limiter.service';
import { RATE_LIMITER } from '../../redis/rate-limiter.service';
import { RedisKeys } from '../../redis/redis.keys';

const OTP_LENGTH = 6;
const OTP_TTL_MS = 5 * 60 * 1000; // 5 min
const RESEND_COOLDOWN_S = 60;
const MAX_PER_HOUR = 5; // per MSISDN
const MAX_ATTEMPTS = 5; // verify attempts per request

const OTP_TTL_S = OTP_TTL_MS / 1000;
// Redis TTL for the OTP record. Kept slightly longer than the logical lifetime
// so that a code which has *just* expired by `expiresAt` is still present long
// enough to produce the exact `GoneException` message the API contract promises,
// instead of silently vanishing into the generic "invalid/already-used" path.
// Logical expiry is still driven solely by `expiresAt` (Redis TTL is the reaper).
const OTP_KEY_TTL_S = OTP_TTL_S + 60;
const HOURLY_WINDOW_S = 60 * 60; // rolling hour for the per-MSISDN ceiling

/**
 * OTP purposes. `login` is the default (phone sign-in/registration) and matches
 * the historical schema default, so existing callers are unchanged. `phone_change`
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

/**
 * The OTP record as persisted in Redis under {@link RedisKeys.otp}. The spec's
 * core triple is `{ code, attempts, createdAt }`; the remaining fields carry the
 * request metadata the flow needs to reproduce the previous behaviour exactly
 * (purpose isolation, cooldown, channel echo, request_id-based lookups).
 *
 * `codeHash` holds the sha256 hash of the plaintext OTP — the plaintext is
 * never stored, matching the previous `codeHash` column. There is no
 * `consumedAt`: a
 * consumed OTP is *deleted*, so presence of the key == still redeemable.
 */
interface OtpRecord {
  requestId: string;
  phoneE164: string;
  codeHash: string; // sha256(plaintext) — never the plaintext OTP
  channel: OtpChannel;
  purpose: string;
  attempts: number;
  resendCount: number;
  createdAt: number; // epoch ms
  expiresAt: number; // epoch ms
  lastSentAt: number; // epoch ms
}

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly devMode: boolean;

  constructor(
    private readonly redis: RedisService,
    private readonly sms: SmsService,
    private readonly config: ConfigService,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiter,
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

  /**
   * Write the OTP record under its phone key AND the request_id -> phone pointer,
   * both with the same Redis TTL so they are reaped together. Called on both the
   * initial issue and every resend.
   */
  private async persist(record: OtpRecord): Promise<void> {
    await this.redis.setEx(RedisKeys.otp(record.phoneE164), OTP_KEY_TTL_S, record);
    await this.redis.setEx(
      RedisKeys.otpRequest(record.requestId),
      OTP_KEY_TTL_S,
      record.phoneE164,
    );
  }

  /** Load the active record for a phone, or null if none/expired-and-reaped. */
  private async loadByPhone(phoneE164: string): Promise<OtpRecord | null> {
    return this.redis.get<OtpRecord>(RedisKeys.otp(phoneE164));
  }

  /** Resolve a request_id to its phone, then load the record for that phone. */
  private async loadByRequestId(requestId: string): Promise<OtpRecord | null> {
    const phone = await this.redis.get<string>(RedisKeys.otpRequest(requestId));
    if (!phone) return null;
    const record = await this.loadByPhone(phone);
    // Guard against a stale pointer outliving a superseded record.
    if (!record || record.requestId !== requestId) return null;
    return record;
  }

  /**
   * Rolling "N per hour per MSISDN" ceiling. Delegated to the injected
   * {@link RateLimiter} (fixed-window: INCR + first-hit EXPIRE under the hood) —
   * the limit (`MAX_PER_HOUR`), window (`HOURLY_WINDOW_S`) and 429 error are
   * unchanged; only the counter mechanics moved into shared infrastructure.
   */
  private async enforceHourlyCeiling(phoneE164: string): Promise<void> {
    const { allowed } = await this.rateLimiter.consume(
      RedisKeys.rateOtpRequest(phoneE164),
      MAX_PER_HOUR,
      HOURLY_WINDOW_S,
    );
    if (!allowed) {
      throw new HttpException(
        'Too many OTP requests. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async deliver(phoneE164: string, code: string): Promise<void> {
    // The 'otp' argument is an accounting-only template label (persisted by
    // SmsService); the rendered text — and therefore the code — is never stored.
    // Delivery behaviour is unchanged.
    await this.sms.sendSms(
      phoneE164,
      `Mator: tasdiqlash kodingiz ${code}. Hech kimga bermang. Amal qilish muddati 5 daqiqa.`,
      'otp',
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
   * `purpose` defaults to `login`, so the phone sign-in flow is unchanged. Other
   * flows (e.g. changing the account phone number) pass a distinct purpose so
   * their codes are namespaced and can only be verified by the matching flow.
   */
  async request(
    phoneE164: string,
    channel: OtpChannel = OtpChannel.SMS,
    purpose: OtpPurpose = OtpPurpose.LOGIN,
  ): Promise<OtpIssued> {
    await this.enforceHourlyCeiling(phoneE164);

    const code = this.generateCode();
    const now = Date.now();
    const expiresAt = new Date(now + OTP_TTL_MS);
    const requestId = prefixedId(IdPrefix.OTP);
    const record: OtpRecord = {
      requestId,
      phoneE164,
      codeHash: this.hash(code),
      channel,
      purpose,
      attempts: 0,
      resendCount: 0,
      createdAt: now,
      expiresAt: expiresAt.getTime(),
      lastSentAt: now,
    };
    await this.persist(record);

    const devOtpCode = await this.dispatch(phoneE164, code);
    this.logger.log(`OTP issued ${requestId} for ${maskPhone(phoneE164)}`);
    return {
      requestId,
      expiresAt,
      resendAfterSeconds: RESEND_COOLDOWN_S,
      otpLength: OTP_LENGTH,
      channel,
      devOtpCode,
    };
  }

  /** Resend using the same request_id (AuthOtpVerifyScreen). */
  async resend(requestId: string): Promise<OtpIssued> {
    const record = await this.loadByRequestId(requestId);
    // A reaped (expired) or already-consumed record reads as absent — same
    // rejection the DB path gave for a missing/consumed row.
    if (!record) {
      throw new BadRequestException('Invalid or already-used OTP request');
    }

    const sinceLast = (Date.now() - record.lastSentAt) / 1000;
    if (sinceLast < RESEND_COOLDOWN_S) {
      throw new HttpException(
        `Please wait ${Math.ceil(RESEND_COOLDOWN_S - sinceLast)}s before requesting a new code.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    await this.enforceHourlyCeiling(record.phoneE164);

    const code = this.generateCode();
    const now = Date.now();
    const expiresAt = new Date(now + OTP_TTL_MS);
    const updated: OtpRecord = {
      ...record,
      codeHash: this.hash(code),
      expiresAt: expiresAt.getTime(),
      lastSentAt: now,
      attempts: 0,
      resendCount: record.resendCount + 1,
    };
    await this.persist(updated);

    const devOtpCode = await this.dispatch(record.phoneE164, code);
    return {
      requestId: record.requestId,
      expiresAt,
      resendAfterSeconds: RESEND_COOLDOWN_S,
      otpLength: OTP_LENGTH,
      channel: record.channel,
      devOtpCode,
    };
  }

  /**
   * Validate a code for a request. On success the request is consumed (single
   * use) by deleting its Redis record. Throws on every failure path with a
   * specific status.
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
    const record = await this.loadByRequestId(requestId);
    if (
      !record ||
      record.phoneE164 !== phoneE164 ||
      (purpose !== undefined && record.purpose !== purpose)
    ) {
      throw new BadRequestException('Invalid or already-used verification request');
    }
    if (record.expiresAt < Date.now()) {
      throw new GoneException('Verification code has expired. Please request a new one.');
    }
    if (record.attempts >= MAX_ATTEMPTS) {
      throw new HttpException(
        'Too many incorrect attempts. Please request a new code.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (this.hash(code) !== record.codeHash) {
      // Increment attempts in place, preserving the remaining TTL so a wrong
      // guess can never extend the code's lifetime.
      await this.bumpAttempts(record);
      throw new UnauthorizedException('Incorrect verification code');
    }

    // Atomic single-use consume: delete the record keyed on this exact request.
    // DEL returns the number of keys removed — 1 for the winner, 0 for a
    // concurrent double-submit that already deleted it — so only the FIRST of
    // two concurrent verifications succeeds; the loser is rejected. Closes the
    // read-then-write race where a code could otherwise be redeemed twice.
    const removed = await this.redis.del(RedisKeys.otp(record.phoneE164));
    await this.redis.del(RedisKeys.otpRequest(record.requestId));
    if (removed === 0) {
      throw new BadRequestException('Invalid or already-used verification request');
    }
  }

  /**
   * Increment the stored attempt counter without extending the code's lifetime.
   * Re-reads under the current TTL and writes back with that same remaining TTL,
   * so a burst of wrong guesses cannot keep a stale code alive.
   */
  private async bumpAttempts(record: OtpRecord): Promise<void> {
    const remainingTtl = await this.redis.ttl(RedisKeys.otp(record.phoneE164));
    const updated: OtpRecord = { ...record, attempts: record.attempts + 1 };
    // ttl <= 0 means the key is gone/expiring; skip rather than resurrect it.
    if (remainingTtl > 0) {
      await this.redis.setEx(RedisKeys.otp(record.phoneE164), remainingTtl, updated);
    }
  }

  /**
   * Verify the most recent still-active OTP for a `(phone, purpose)` pair,
   * without the caller having to carry a request_id. Used by flows whose
   * confirm step only knows the phone + code (e.g. changing the account phone
   * number). Resolves the record at the phone key, then delegates to
   * {@link verify} so every security rule (purpose isolation, attempt ceiling,
   * single-use consume) is applied exactly once.
   */
  async verifyLatestForPhone(phoneE164: string, code: string, purpose: OtpPurpose): Promise<void> {
    const record = await this.loadByPhone(phoneE164);
    if (
      !record ||
      record.purpose !== purpose ||
      record.expiresAt <= Date.now()
    ) {
      throw new BadRequestException('No active verification request for this phone. Please request a new code.');
    }
    await this.verify(record.requestId, phoneE164, code, purpose);
  }
}
