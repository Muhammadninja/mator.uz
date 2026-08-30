import { BadRequestException, Inject, Injectable, forwardRef } from '@nestjs/common';
import {
  AuthProvider,
  LegalDocumentType,
  OtpChannel,
  Role,
  type AppUser,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { OtpService, OtpPurpose } from './otp.service';
import { TokenService } from '../tokens/token.service';
import {
  LegalService,
  LEGAL_ACCEPTANCE_REQUIRED,
  type ClaimedAcceptance,
  type LegalAcceptanceContext,
} from '../../legal/legal.service';
import { prefixedId, IdPrefix } from '../../common/ulid.util';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { LegalAcceptanceInputDto } from './dto/legal-acceptance.dto';

@Injectable()
export class PhoneAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly tokens: TokenService,
    // forwardRef: LegalModule imports AuthModule for the JWT guard, and this
    // service needs LegalService — a legitimate cycle between two modules that
    // genuinely depend on each other.
    @Inject(forwardRef(() => LegalService))
    private readonly legal: LegalService,
  ) {}

  async checkAvailability(phoneE164: string) {
    const existing = await this.prisma.appUser.findUnique({ where: { phoneE164 } });
    return { phone_e164: phoneE164, is_existing_user: !!existing };
  }

  async requestOtp(dto: RequestOtpDto) {
    const phoneE164 = dto.phone_e164.trim();
    const channel = (dto.channel?.toUpperCase() as OtpChannel) ?? OtpChannel.SMS;
    // `dto.lang` is already normalized by RequestOtpDto's @Transform; passing it
    // through (and passing `undefined` when the client sent nothing) lets
    // OtpService apply the `uz` default in the single place that owns it.
    const issued = await this.otp.request(
      phoneE164,
      channel,
      OtpPurpose.LOGIN,
      dto.lang,
    );
    const existing = await this.prisma.appUser.findUnique({ where: { phoneE164 } });

    return {
      request_id: issued.requestId,
      phone_e164: phoneE164,
      expires_at: issued.expiresAt.toISOString(),
      resend_after_seconds: issued.resendAfterSeconds,
      otp_length: issued.otpLength,
      delivery_channel: issued.channel.toLowerCase(),
      is_existing_user: !!existing,
      next_screen: 'AuthOtpVerifyScreen',
      // AUTH_DEV_MODE only: present so the frontend can auto-fill the OTP
      // without an SMS provider. Never set in production.
      ...(issued.devOtpCode ? { dev_otp_code: issued.devOtpCode } : {}),
    };
  }

  async resendOtp(requestId: string) {
    const issued = await this.otp.resend(requestId);
    return {
      request_id: issued.requestId,
      expires_at: issued.expiresAt.toISOString(),
      resend_after_seconds: issued.resendAfterSeconds,
      otp_length: issued.otpLength,
      // AUTH_DEV_MODE only — see requestOtp. Never set in production.
      ...(issued.devOtpCode ? { dev_otp_code: issued.devOtpCode } : {}),
    };
  }

  async verifyOtp(dto: VerifyOtpDto, context: LegalAcceptanceContext = {}) {
    const phoneE164 = dto.phone_e164.trim();
    await this.otp.verify(dto.request_id, phoneE164, dto.otp_code);

    const user = await this.findOrCreateByPhone(phoneE164, dto.legal, context);
    const device = await this.bindDevice(user.id, dto.device);
    const session = await this.tokens.issueSession(
      { id: user.id, email: user.email, role: user.role, tokenVersion: user.tokenVersion },
      { deviceId: device?.id ?? null },
    );

    // Mator v1 is phone-OTP only: MyID is no longer part of onboarding, so
    // login always lands on the garage. The MyID endpoints remain available for
    // optional verification later (see auth.controller.ts).
    return {
      user: this.presentUser(user),
      tokens: {
        access_token: session.accessToken,
        access_token_expires_at: session.accessTokenExpiresAt.toISOString(),
        refresh_token: session.refreshToken,
        refresh_token_expires_at: session.refreshTokenExpiresAt.toISOString(),
        token_type: session.tokenType,
      },
      device_binding: {
        device_id: device?.id ?? null,
        expo_push_token_registered: !!device?.expoPushToken,
      },
      next_screen: 'GarageListScreen',
    };
  }

  /**
   * Resolve the account for a verified phone number, creating it on first use.
   *
   * REGISTRATION (no account yet) requires legal consent: the account and its
   * consent records are written in ONE transaction, so an account can never
   * exist without the consent it was created under.
   *
   * SIGN-IN (account exists) deliberately does NOT require the `legal` block.
   * This one route serves both, and demanding consent here would lock every
   * existing user out the moment a new document version is published. They
   * re-accept through POST /v1/legal/accept, which GET /v1/legal/status prompts.
   */
  private async findOrCreateByPhone(
    phoneE164: string,
    legal: LegalAcceptanceInputDto | undefined,
    context: LegalAcceptanceContext,
  ): Promise<AppUser> {
    const existing = await this.prisma.appUser.findUnique({ where: { phoneE164 } });
    if (existing) {
      if (!existing.phoneVerified) {
        return this.prisma.appUser.update({
          where: { id: existing.id },
          data: { phoneVerified: true },
        });
      }
      return existing;
    }

    // Registration. Consent is mandatory and validated against the versions
    // actually in force — the claimed versions below are only what the client
    // says it displayed.
    if (!legal) {
      throw new BadRequestException({
        code: LEGAL_ACCEPTANCE_REQUIRED,
        message: 'Required legal documents must be accepted',
      });
    }
    const claimed = toClaimedAcceptances(legal);

    // New phone account: user + PHONE_OTP identity + legal consent, atomically.
    // A rejected version rolls the account creation back, so a half-registered
    // user without consent is not a reachable state.
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.appUser.create({
        data: {
          phoneE164,
          phoneVerified: true,
          role: Role.USER,
          identities: {
            create: { provider: AuthProvider.PHONE_OTP, providerUserId: phoneE164 },
          },
        },
      });
      await this.legal.acceptWithinTransaction(tx, user.id, claimed, context);
      return user;
    });
  }

  private async bindDevice(userId: string, device: VerifyOtpDto['device']) {
    if (!device?.install_id) {
      return null; // no device payload -> session not bound to a device
    }
    const platform = device.platform.toUpperCase() as 'IOS' | 'ANDROID';
    return this.prisma.device.upsert({
      where: { userId_installId: { userId, installId: device.install_id } },
      create: {
        id: prefixedId(IdPrefix.DEVICE),
        userId,
        installId: device.install_id,
        platform,
        expoPushToken: device.expo_push_token,
        fcmToken: device.fcm_token,
        apnsToken: device.apns_token,
        permissionsGranted: true,
      },
      update: {
        platform,
        expoPushToken: device.expo_push_token,
        fcmToken: device.fcm_token,
        apnsToken: device.apns_token,
        lastSeenAt: new Date(),
      },
    });
  }

  private presentUser(user: AppUser) {
    return {
      id: user.id,
      phone_e164: user.phoneE164,
      display_name: user.displayName,
      avatar_url: user.avatarUrl,
      myid_status: user.myIdStatus.toLowerCase(),
      transaction_limit_uzs: Number(user.transactionLimitUzs),
      created_at: user.createdAt.toISOString(),
    };
  }
}

/**
 * Map the registration DTO's three named version fields onto the generic
 * claimed-acceptance list LegalService validates. Keeps the wire contract
 * explicit (the client names each document) while the validation rules live in
 * exactly one place.
 */
function toClaimedAcceptances(legal: LegalAcceptanceInputDto): ClaimedAcceptance[] {
  return [
    { type: LegalDocumentType.TERMS_OF_USE, version: legal.terms_version },
    { type: LegalDocumentType.PRIVACY_POLICY, version: legal.privacy_version },
    {
      type: LegalDocumentType.PERSONAL_DATA_CONSENT,
      version: legal.personal_data_consent_version,
    },
  ];
}
