import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OtpChannel, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OtpService, OtpPurpose, type OtpProof } from '../auth/phone/otp.service';
import { TokenService } from '../auth/tokens/token.service';
import { presentMe } from './user.presenter';
import { QueueService } from '../queue/queue.service';
import { RedisService } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis.keys';
import { maskPhone } from '../common/pii.util';

/** A phone change is valid for as long as the codes that authorize it. */
const OPERATION_TTL_S = 5 * 60;
/** Kept a little longer, so a late confirm hears "expired" rather than "unknown". */
const OPERATION_KEY_TTL_S = OPERATION_TTL_S + 60;

const PHONE_CHANGED_NOTICE =
  "Mator: hisobingiz telefon raqami o'zgartirildi. Agar bu siz bo'lmasangiz, darhol qo'llab-quvvatlash xizmatiga murojaat qiling.";

/** The one phone change in progress for an account. A new request replaces it. */
interface PendingPhoneChange {
  newPhone: string;
  newRequestId: string;
  /** Null when the account has no number to prove. */
  currentPhone: string | null;
  currentRequestId: string | null;
  expiresAt: number;
}

/**
 * Change-phone flow for an authenticated user, split into request + confirm:
 *
 *   1. request(userId, phone) — validates/normalizes the target number, rejects
 *      a no-op (same as current) or a number owned by someone else, then issues
 *      one OTP to the new number and one to the number on the account, and
 *      records the pair as this account's pending change. An access token alone
 *      therefore cannot move an account: the current SIM has to agree.
 *   2. confirm(userId, phone, otp, currentPhoneOtp) — verifies both codes against
 *      that pending pair, then does the whole state change in ONE transaction that opens by taking the account's row
 *      lock: re-validate under the lock, move every phone-related field, and
 *      revoke all existing sessions — refresh tokens dropped AND the session
 *      version bumped, so live access tokens die too — meaning the old
 *      device/session can't keep acting on the account after a number change.
 *      The lock is what makes two concurrent confirmations (two different target
 *      numbers, each with its own valid OTP) run one after the other, so exactly
 *      one wins and the other gets a 409 instead of a token that is already dead.
 *
 * Phone storage in this schema is a single `phoneE164` column plus the
 * `phoneVerified` flag; there is no separate normalized column, so "update every
 * phone-related field" means those two here.
 */
@Injectable()
export class PhoneChangeService {
  private readonly logger = new Logger(PhoneChangeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly tokens: TokenService,
    private readonly redis: RedisService,
    private readonly queue: QueueService,
  ) {}

  /**
   * Normalize an E.164 phone to a canonical form. The DTO already enforces the
   * E.164 shape; here we strip incidental spaces/dashes a client might send and
   * keep the leading `+` and digits, matching how numbers are stored elsewhere.
   */
  private normalize(phone: string): string {
    const trimmed = phone.trim();
    const digits = trimmed.replace(/[^\d]/g, '');
    return `+${digits}`;
  }

  /** Step 1 — validate the target number and send a phone-change OTP. */
  async request(userId: string, rawPhone: string) {
    const phoneE164 = this.normalize(rawPhone);

    const user = await this.prisma.appUser.findUnique({
      where: { id: userId },
    });
    if (!user) throw new NotFoundException('User not found');

    if (user.phoneE164 === phoneE164) {
      throw new BadRequestException(
        'This is already your current phone number.',
      );
    }

    await this.assertAvailable(phoneE164, userId);

    // Always the number on the account, never one the client names.
    const currentPhone = user.phoneE164;
    const issued = await this.otp.request(
      phoneE164,
      OtpChannel.SMS,
      OtpPurpose.PHONE_CHANGE,
    );
    const issuedCurrent = currentPhone
      ? await this.otp.request(
          currentPhone,
          OtpChannel.SMS,
          OtpPurpose.PHONE_CHANGE_CURRENT,
        )
      : null;

    const pending: PendingPhoneChange = {
      newPhone: phoneE164,
      newRequestId: issued.requestId,
      currentPhone,
      currentRequestId: issuedCurrent?.requestId ?? null,
      expiresAt: Date.now() + OPERATION_TTL_S * 1000,
    };
    await this.redis.setEx(
      RedisKeys.phoneChange(userId),
      OPERATION_KEY_TTL_S,
      pending,
    );

    return {
      phone: phoneE164,
      current_phone_otp_required: !!currentPhone,
      ...(currentPhone ? { current_phone_masked: maskPhone(currentPhone) } : {}),
      expires_at: issued.expiresAt.toISOString(),
      resend_after_seconds: issued.resendAfterSeconds,
      otp_length: issued.otpLength,
      delivery_channel: issued.channel.toLowerCase(),
      // AUTH_DEV_MODE only: present so the client can auto-fill without an SMS
      // provider. Never set in production. Mirrors the sign-in OTP contract.
      ...(issued.devOtpCode ? { dev_otp_code: issued.devOtpCode } : {}),
      ...(issuedCurrent?.devOtpCode
        ? { dev_current_phone_otp_code: issuedCurrent.devOtpCode }
        : {}),
    };
  }

  /** Step 2 — verify both OTPs and move the account to the new number. */
  async confirm(
    userId: string,
    rawPhone: string,
    otp: string,
    currentPhoneOtp?: string,
  ) {
    const phoneE164 = this.normalize(rawPhone);

    const user = await this.prisma.appUser.findUnique({
      where: { id: userId },
    });
    if (!user) throw new NotFoundException('User not found');

    if (user.phoneE164 === phoneE164) {
      throw new BadRequestException(
        'This is already your current phone number.',
      );
    }

    await this.verifyProofs(user.phoneE164, userId, phoneE164, otp, currentPhoneOtp);

    // The number move and the session revocation commit together or not at all:
    // a failure between them would leave the account on the new number with the
    // old device's sessions still live. Token *signing* stays outside the
    // transaction — it is CPU work with no database state, and holding a
    // transaction open across it would pin a connection for no reason.
    const { updated, tokenVersion } = await this.prisma.$transaction(
      async (tx) => {
        // Serialize confirmations for this account. Two DIFFERENT phone-change
        // OTPs (one per target number) are both individually valid and can
        // arrive together; without this lock they interleave — both read the
        // same "current" number, both write, both bump — and the first caller
        // walks away with a 200 and a token the second bump already killed.
        // The write lock makes the second confirm wait here until the first
        // commits, so it then re-reads real post-commit state below.
        await tx.$queryRaw`SELECT id FROM app_users WHERE id = ${userId}::uuid FOR UPDATE`;

        // Everything the decision depends on is re-read UNDER the lock; what we
        // validated before the transaction may be several commits stale.
        const locked = await tx.appUser.findUnique({ where: { id: userId } });
        if (!locked) throw new NotFoundException('User not found');
        if (locked.phoneE164 === phoneE164) {
          throw new BadRequestException(
            'This is already your current phone number.',
          );
        }
        // The OTP authorized a move away from the number the account had when
        // this request started. If it moved in the meantime, another
        // confirmation won the race and this one is acting on a stale premise —
        // reject it instead of clobbering the winner and handing back a token
        // that a second bump has already invalidated.
        if (locked.phoneE164 !== user.phoneE164) {
          throw new ConflictException(
            'The account phone number changed while this request was in flight. Please start over.',
          );
        }
        // Someone could have claimed the target number between request and
        // confirm; the unique index is the real guard, this is the nice error.
        await this.assertAvailable(phoneE164, userId, tx);

        const updated = await tx.appUser.update({
          where: { id: userId },
          data: { phoneE164, phoneVerified: true },
        });
        // Single revocation entry point (same one logout-all uses): drops the
        // refresh family AND bumps the session version, so the access tokens
        // already in flight — which outlive the refresh sweep, being stateless
        // — are rejected from their very next request.
        const tokenVersion = await this.tokens.revokeAllSessions(userId, tx);
        return { updated, tokenVersion };
      },
    );

    // Post-commit: only now is the new version visible to other connections, so
    // a socket dropped here cannot immediately reconnect against stale state.
    this.tokens.notifySessionsRevoked(userId);
    await this.notifyPreviousPhone(user.phoneE164);

    // Issue a fresh pair for the SAME user so the client swaps tokens
    // transparently — the phone change is seamless, with no forced re-login.
    const session = await this.tokens.issueSession({
      id: updated.id,
      email: updated.email,
      role: updated.role,
      // The bumped version, NOT `updated.tokenVersion` — that row was read
      // before the increment and would mint an already-invalid token.
      tokenVersion,
    });

    // Same token envelope the phone sign-in flow returns (snake_case), so the
    // client reuses its existing token-handling code.
    return {
      user: presentMe(updated),
      tokens: {
        access_token: session.accessToken,
        access_token_expires_at: session.accessTokenExpiresAt.toISOString(),
        refresh_token: session.refreshToken,
        refresh_token_expires_at: session.refreshTokenExpiresAt.toISOString(),
        token_type: session.tokenType,
      },
    };
  }

  /**
   * Both codes must belong to this account's one pending change: the same target,
   * the same current number, not expired, and not replaced by a later request. Each
   * is checked before either is used, and the pending change is claimed last, so a
   * request that fails here leaves the buyer free to correct a mistyped code.
   */
  private async verifyProofs(
    accountPhone: string | null,
    userId: string,
    newPhone: string,
    otp: string,
    currentPhoneOtp?: string,
  ): Promise<void> {
    const key = RedisKeys.phoneChange(userId);
    const pending = await this.redis.get<PendingPhoneChange>(key);
    if (!pending || pending.newPhone !== newPhone) {
      throw new BadRequestException({
        code: 'PHONE_CHANGE_NOT_REQUESTED',
        message: 'No phone change was requested for this number.',
      });
    }
    if (pending.expiresAt <= Date.now()) {
      throw new GoneException({
        code: 'PHONE_CHANGE_EXPIRED',
        message: 'This phone change has expired. Please start over.',
      });
    }
    // The account moved since the codes were sent.
    if (pending.currentPhone !== accountPhone) {
      throw new ConflictException(
        'The account phone number changed while this request was in flight. Please start over.',
      );
    }

    const proofs: OtpProof[] = [
      {
        requestId: pending.newRequestId,
        phoneE164: newPhone,
        code: otp,
        purpose: OtpPurpose.PHONE_CHANGE,
      },
    ];
    if (accountPhone) {
      if (!currentPhoneOtp || !pending.currentRequestId) {
        throw new ForbiddenException({
          code: 'CURRENT_PHONE_PROOF_REQUIRED',
          message: 'Enter the code sent to your current phone number.',
        });
      }
      proofs.push({
        requestId: pending.currentRequestId,
        phoneE164: accountPhone,
        code: currentPhoneOtp,
        purpose: OtpPurpose.PHONE_CHANGE_CURRENT,
      });
    }
    await this.otp.verifyAll(proofs);
    await this.redis.del(key);
  }

  /**
   * Tell the number the account just left. Best effort: the change has committed, and
   * this runs for a legitimate move as often as for a hostile one.
   */
  private async notifyPreviousPhone(phone: string | null): Promise<void> {
    if (!phone) return;
    try {
      await this.queue.enqueueSms({
        phone,
        message: PHONE_CHANGED_NOTICE,
        template: 'phone_changed',
      });
    } catch (err) {
      this.logger.error(
        `Could not queue the phone-change notice for ${maskPhone(phone)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Ensure `phoneE164` is not already taken by a *different* user. Uses the
   * unique `phoneE164` index as the source of truth. Pass `db` to read inside a
   * transaction (the confirm path checks under the account's row lock).
   */
  private async assertAvailable(
    phoneE164: string,
    userId: string,
    db: Prisma.TransactionClient = this.prisma,
  ) {
    const owner = await db.appUser.findUnique({
      where: { phoneE164 },
    });
    if (owner && owner.id !== userId) {
      throw new ConflictException(
        'This phone number is already in use by another account.',
      );
    }
  }
}
