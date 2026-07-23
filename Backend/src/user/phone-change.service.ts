import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OtpChannel } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OtpService, OtpPurpose } from '../auth/phone/otp.service';
import { TokenService } from '../auth/tokens/token.service';
import { presentMe } from './user.presenter';

/**
 * Change-phone flow for an authenticated user, split into request + confirm:
 *
 *   1. request(userId, phone) — validates/normalizes the target number, rejects
 *      a no-op (same as current) or a number owned by someone else, then issues
 *      a `phone_change`-purpose OTP through the shared {@link OtpService}
 *      (same rate limits + delivery as sign-in).
 *   2. confirm(userId, phone, otp) — verifies that OTP, re-checks availability,
 *      moves every phone-related field onto the account, and revokes all
 *      existing sessions so the old device/session can't keep acting on the
 *      account after a number change.
 *
 * Phone storage in this schema is a single `phoneE164` column plus the
 * `phoneVerified` flag; there is no separate normalized column, so "update every
 * phone-related field" means those two here.
 */
@Injectable()
export class PhoneChangeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly tokens: TokenService,
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

    const issued = await this.otp.request(
      phoneE164,
      OtpChannel.SMS,
      OtpPurpose.PHONE_CHANGE,
    );

    return {
      phone: phoneE164,
      expires_at: issued.expiresAt.toISOString(),
      resend_after_seconds: issued.resendAfterSeconds,
      otp_length: issued.otpLength,
      delivery_channel: issued.channel.toLowerCase(),
      // AUTH_DEV_MODE only: present so the client can auto-fill without an SMS
      // provider. Never set in production. Mirrors the sign-in OTP contract.
      ...(issued.devOtpCode ? { dev_otp_code: issued.devOtpCode } : {}),
    };
  }

  /** Step 2 — verify the OTP and move the account to the new number. */
  async confirm(userId: string, rawPhone: string, otp: string) {
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

    // Verifies the newest active phone_change OTP for this number, applying
    // expiry/attempt/single-use rules; throws on any failure.
    await this.otp.verifyLatestForPhone(
      phoneE164,
      otp,
      OtpPurpose.PHONE_CHANGE,
    );

    // Re-check availability at confirm time: someone could have claimed the
    // number between request and confirm.
    await this.assertAvailable(phoneE164, userId);

    const updated = await this.prisma.appUser.update({
      where: { id: userId },
      data: { phoneE164, phoneVerified: true },
    });

    // Rotate the whole session family: revoke every existing refresh token (so
    // no stale session keeps acting on the account after an identity change),
    // then immediately issue a fresh access + refresh pair for the SAME user.
    // The client swaps in the new tokens transparently — the phone change is
    // seamless, with no forced re-login. Ordering matters: revoke first, then
    // issue, so the new pair is never caught by the revoke.
    await this.tokens.revokeAllForUser(userId);
    const session = await this.tokens.issueSession({
      id: updated.id,
      email: updated.email,
      role: updated.role,
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
   * Ensure `phoneE164` is not already taken by a *different* user. Uses the
   * unique `phoneE164` index as the source of truth.
   */
  private async assertAvailable(phoneE164: string, userId: string) {
    const owner = await this.prisma.appUser.findUnique({
      where: { phoneE164 },
    });
    if (owner && owner.id !== userId) {
      throw new ConflictException(
        'This phone number is already in use by another account.',
      );
    }
  }
}
