import { Injectable } from '@nestjs/common';
import { AuthProvider, OtpChannel, Role, type AppUser } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { OtpService } from './otp.service';
import { TokenService } from '../tokens/token.service';
import { prefixedId, IdPrefix } from '../../common/ulid.util';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';

@Injectable()
export class PhoneAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly tokens: TokenService,
  ) {}

  async checkAvailability(phoneE164: string) {
    const existing = await this.prisma.appUser.findUnique({ where: { phoneE164 } });
    return { phone_e164: phoneE164, is_existing_user: !!existing };
  }

  async requestOtp(dto: RequestOtpDto) {
    const phoneE164 = dto.phone_e164.trim();
    const channel = (dto.channel?.toUpperCase() as OtpChannel) ?? OtpChannel.SMS;
    const issued = await this.otp.request(phoneE164, channel);
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

  async verifyOtp(dto: VerifyOtpDto) {
    const phoneE164 = dto.phone_e164.trim();
    await this.otp.verify(dto.request_id, phoneE164, dto.otp_code);

    const user = await this.findOrCreateByPhone(phoneE164);
    const device = await this.bindDevice(user.id, dto.device);
    const session = await this.tokens.issueSession(
      { id: user.id, email: user.email, role: user.role },
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

  private async findOrCreateByPhone(phoneE164: string): Promise<AppUser> {
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

    // New phone account: create user + the PHONE_OTP identity atomically.
    return this.prisma.appUser.create({
      data: {
        phoneE164,
        phoneVerified: true,
        role: Role.USER,
        identities: {
          create: { provider: AuthProvider.PHONE_OTP, providerUserId: phoneE164 },
        },
      },
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
