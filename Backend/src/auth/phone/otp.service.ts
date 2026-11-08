import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  UnauthorizedException,
  GoneException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomInt } from 'crypto';
import { OtpChannel } from '@prisma/client';
import { QueueService } from '../../queue/queue.service';
import { prefixedId, IdPrefix } from '../../common/ulid.util';
import { maskPhone } from '../../common/pii.util';
import {
  RedisService,
  assertRedisBacklogRoom,
  withRedisTimeout,
} from '../../redis/redis.service';
import type {
  RateLimiter,
  RateLimitResult,
} from '../../redis/rate-limiter.service';
import { RATE_LIMITER } from '../../redis/rate-limiter.service';
import { RedisKeys } from '../../redis/redis.keys';
import { resolveSmsLang, type SmsLang } from '../../sms/otp-message.i18n';

const OTP_LENGTH = 6;
const OTP_TTL_MS = 5 * 60 * 1000; // 5 min
const RESEND_COOLDOWN_S = 60;
const MAX_PER_HOUR = 5; // per MSISDN
const MAX_ATTEMPTS = 5; // code comparisons per request_id, ever
/**
 * Code comparisons per phone per hour, across every request_id. Two codes' worth
 * of attempts: the most a person mistyping needs, and a fifth of what the issue
 * ceiling (5 codes x 5 attempts) would otherwise allow a guesser.
 */
const MAX_VERIFY_PER_HOUR = 10;
/** How long a verification waits for the limiter before refusing with a 503. */
const VERIFY_LIMITER_TIMEOUT_MS = 2_000;

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
  /** Proof of control of the number an account is moving away from. */
  PHONE_CHANGE_CURRENT: 'phone_change_current',
} as const;
export type OtpPurpose = (typeof OtpPurpose)[keyof typeof OtpPurpose];

/** One code to check; see {@link OtpService.verifyAll}. */
export interface OtpProof {
  requestId: string;
  phoneE164: string;
  code: string;
  purpose: OtpPurpose;
}

/**
 * Where a record and its limits live. The phone number itself, except for a proof of
 * the current number, which is sent to a number that may be signing in at the same
 * moment and has its own place: asking for it must neither replace a live login code
 * nor spend that number's login allowance.
 */
function slotOf(phoneE164: string, purpose: string): string {
  return purpose === OtpPurpose.PHONE_CHANGE_CURRENT
    ? `${purpose}:${phoneE164}`
    : phoneE164;
}

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
  /**
   * Language of the OTP SMS, normalized at issue time. Stored so a RESEND —
   * which only knows the request_id — reaches the user in the same language as
   * the first send. Records written before this field existed read as
   * `undefined` and are re-resolved to the default on use.
   */
  lang: SmsLang;
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
    // The QUEUE, not SmsService: OTP delivery is enqueued and executed by
    // SmsProcessor. Nothing on the request path talks to an SMS provider.
    private readonly queue: QueueService,
    private readonly config: ConfigService,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiter,
  ) {
    this.devMode = this.config.get<string>('AUTH_DEV_MODE') === 'true';
    // Defence in depth behind the boot-time guard (validateAuthEnv): even a
    // process assembled without that ConfigModule hook must never serve OTP
    // codes in API responses in production.
    if (this.devMode && this.config.get<string>('NODE_ENV') === 'production') {
      throw new Error(
        'AUTH_DEV_MODE=true is forbidden in production (OTP codes would be returned in API responses).',
      );
    }
    if (this.devMode) {
      this.logger.warn('AUTH_DEV_MODE is ON — OTPs are returned in the API, SMS is skipped. Do NOT enable in production.');
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
    const slot = slotOf(record.phoneE164, record.purpose);
    await this.redis.setEx(RedisKeys.otp(slot), OTP_KEY_TTL_S, record);
    await this.redis.setEx(
      RedisKeys.otpRequest(record.requestId),
      OTP_KEY_TTL_S,
      slot,
    );
  }

  /** Load the active record for a phone, or null if none/expired-and-reaped. */
  private async loadByPhone(phoneE164: string): Promise<OtpRecord | null> {
    return this.redis.get<OtpRecord>(RedisKeys.otp(phoneE164));
  }

  /** Resolve a request_id to its phone, then load the record for that phone. */
  private async loadByRequestId(requestId: string): Promise<OtpRecord | null> {
    const slot = await this.redis.get<string>(RedisKeys.otpRequest(requestId));
    if (!slot) return null;
    const record = await this.loadByPhone(slot);
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
  private async enforceHourlyCeiling(slot: string): Promise<void> {
    const { allowed } = await this.rateLimiter.consume(
      RedisKeys.rateOtpRequest(slot),
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

  /**
   * ENQUEUE the OTP SMS — the provider is never called on the request path.
   *
   * The OTP record is already persisted in Redis (the source of truth for
   * verification) before this runs, so the code is redeemable the moment it is
   * issued regardless of when the SMS actually goes out. Delivery is retried by
   * BullMQ (bounded attempts + exponential backoff) instead of failing the HTTP
   * request; the user can also resend, which is the real recovery path.
   *
   * `jobId` is keyed on (requestId, sendCount) so a retried request cannot
   * double-send the same code while a genuine resend still delivers.
   * The queue seals the code and the job carries only a reference to it (see
   * OtpJobSecretStore): the aggregator-approved template is rendered by
   * `SmsService.sendOtp` on the worker. The 'otp' template label it passes on is accounting-only — the
   * rendered text (and therefore the code) is never persisted by SmsService.
   */
  private async deliver(
    phoneE164: string,
    code: string,
    requestId: string,
    sendCount: number,
    lang: SmsLang,
    expiresAt: number,
  ): Promise<void> {
    await this.queue.enqueueOtpSms(
      { phone: phoneE164, otp: { code, lang, expiresAt } },
      { jobId: this.queue.otpSmsJobId(requestId, sendCount) },
    );
  }

  /**
   * Route a freshly generated OTP to the user. In dev mode the SMS pipeline is
   * skipped entirely — the code is returned to the caller so the
   * frontend can complete auth without a provider. In every other case this
   * enqueues the delivery via {@link deliver}.
   * Returns the plaintext code only in dev mode; `undefined` otherwise.
   *
   * Enqueue failures are logged and swallowed: the OTP is already valid in Redis
   * and the user can resend, so a queue hiccup must not fail an otherwise
   * successful issue (and must not leak a 500 to the auth screen).
   */
  private async dispatch(
    phoneE164: string,
    code: string,
    requestId: string,
    sendCount: number,
    lang: SmsLang,
    expiresAt: number,
  ): Promise<string | undefined> {
    if (this.devMode) {
      this.logger.warn(
        `[AUTH_DEV_MODE] OTP issued for ${maskPhone(phoneE164)} (SMS skipped)`,
      );
      return code;
    }
    try {
      await this.deliver(phoneE164, code, requestId, sendCount, lang, expiresAt);
    } catch (err) {
      this.logger.error(
        `Failed to enqueue OTP SMS for ${maskPhone(phoneE164)} (code is still valid; user can resend): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return undefined;
  }

  /**
   * Create + send a new OTP for a phone number (AuthPhoneEntryScreen).
   *
   * `purpose` defaults to `login`, so the phone sign-in flow is unchanged. Other
   * flows (e.g. changing the account phone number) pass a distinct purpose so
   * their codes are namespaced and can only be verified by the matching flow.
   *
   * `lang` is the client's requested SMS language and is normalized HERE, at the
   * boundary: everything downstream (the Redis record, the queue payload, the
   * resend) then carries a value that is guaranteed to be supported. Omitting it
   * — as every existing caller does — yields the default (`uz`).
   */
  async request(
    phoneE164: string,
    channel: OtpChannel = OtpChannel.SMS,
    purpose: OtpPurpose = OtpPurpose.LOGIN,
    lang?: string | null,
  ): Promise<OtpIssued> {
    await this.enforceHourlyCeiling(slotOf(phoneE164, purpose));

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
      lang: resolveSmsLang(lang),
      resendCount: 0,
      createdAt: now,
      expiresAt: expiresAt.getTime(),
      lastSentAt: now,
    };
    await this.persist(record);

    // sendCount 0 — the initial issue for this requestId.
    const devOtpCode = await this.dispatch(
      phoneE164,
      code,
      requestId,
      0,
      record.lang,
      record.expiresAt,
    );
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
    // The five attempts belong to the request_id and a resend keeps it, so a
    // spent request cannot be reopened, and an SMS for it could never be used.
    const attemptsKey = RedisKeys.otpAttempts(requestId);
    const { remaining } = await this.rateLimiter.check(attemptsKey, MAX_ATTEMPTS);
    if (remaining === 0) {
      throw new HttpException(
        'Too many incorrect attempts. Please request a new code.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    await this.enforceHourlyCeiling(slotOf(record.phoneE164, record.purpose));

    const code = this.generateCode();
    const now = Date.now();
    const expiresAt = new Date(now + OTP_TTL_MS);
    const updated: OtpRecord = {
      ...record,
      codeHash: this.hash(code),
      expiresAt: expiresAt.getTime(),
      lastSentAt: now,
      resendCount: record.resendCount + 1,
    };
    // The new code lives longer than the counter was armed for: keep the counter
    // alive with it, or attempts already spent would be forgiven when it lapses.
    await this.redis.expire(attemptsKey, OTP_KEY_TTL_S);
    await this.persist(updated);

    // A resend mints a NEW code, so it must reach the user: keying the job on
    // the bumped resendCount gives it a distinct id from the previous send.
    const devOtpCode = await this.dispatch(
      record.phoneE164,
      code,
      record.requestId,
      updated.resendCount,
      // Re-resolved rather than trusted: a record issued by the previous release
      // carries no `lang`, and a resend must not crash on it.
      resolveSmsLang(record.lang),
      updated.expiresAt,
    );
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
    const record = await this.check(requestId, phoneE164, code, purpose);
    await this.consume(record);
  }

  /**
   * Validate several codes as one proof. Every code is checked before any is used,
   * so a mistake in one does not burn the others. Each consume is atomic, so of any
   * number of concurrent callers at most one can use all of them.
   */
  async verifyAll(proofs: readonly OtpProof[]): Promise<void> {
    const records: OtpRecord[] = [];
    for (const p of proofs) {
      records.push(
        await this.check(p.requestId, p.phoneE164, p.code, p.purpose),
      );
    }
    for (const record of records) await this.consume(record);
  }

  /** Throws unless this code is right for this live request; consumes nothing. */
  private async check(
    requestId: string,
    phoneE164: string,
    code: string,
    purpose?: OtpPurpose,
  ): Promise<OtpRecord> {
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
    // Charged BEFORE the comparison and by an atomic counter: however many guesses
    // arrive at once, each one gets its own count, and a correct code that comes
    // after the limit is refused like any other.
    await this.reserveAttempt(record);

    if (this.hash(code) !== record.codeHash) {
      throw new UnauthorizedException('Incorrect verification code');
    }
    return record;
  }

  /**
   * Atomic single-use consume: delete the record keyed on this exact request.
   * DEL returns the number of keys removed — 1 for the winner, 0 for a
   * concurrent double-submit that already deleted it — so only the FIRST of
   * two concurrent verifications succeeds; the loser is rejected. Closes the
   * read-then-write race where a code could otherwise be redeemed twice.
   */
  private async consume(record: OtpRecord): Promise<void> {
    const removed = await this.redis.del(
      RedisKeys.otp(slotOf(record.phoneE164, record.purpose)),
    );
    await this.redis.del(RedisKeys.otpRequest(record.requestId));
    if (removed === 0) {
      throw new BadRequestException('Invalid or already-used verification request');
    }
  }

  /**
   * Take one comparison from the request's five and from the phone's hourly
   * allowance. The request's own limit goes first, so a request already spent
   * stops costing the phone anything. Only a caller naming a live request_id for
   * this phone reaches here: a made-up one cannot use up the owner's allowance.
   */
  private async reserveAttempt(record: OtpRecord): Promise<void> {
    const perRequest = await this.consumeLimit(
      RedisKeys.otpAttempts(record.requestId),
      MAX_ATTEMPTS,
      OTP_KEY_TTL_S,
    );
    if (!perRequest.allowed) {
      throw new HttpException(
        'Too many incorrect attempts. Please request a new code.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const perPhone = await this.consumeLimit(
      RedisKeys.rateOtpVerify(slotOf(record.phoneE164, record.purpose)),
      MAX_VERIFY_PER_HOUR,
      HOURLY_WINDOW_S,
    );
    if (!perPhone.allowed) {
      throw new HttpException(
        'Too many verification attempts. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Fail closed. With no working counter the guess cannot be charged, so it is
   * refused without being compared. Bounded because the shared client otherwise
   * waits out a Redis outage; a command that lands late only over-counts.
   */
  private async consumeLimit(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    try {
      assertRedisBacklogRoom('OTP verification limit');
      return await withRedisTimeout(
        this.rateLimiter.consume(key, limit, windowSeconds),
        VERIFY_LIMITER_TIMEOUT_MS,
        'OTP verification limit',
      );
    } catch (err) {
      this.logger.error(
        `OTP verification refused, its limit could not be checked: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ServiceUnavailableException(
        'Verification is temporarily unavailable. Please try again shortly.',
      );
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
