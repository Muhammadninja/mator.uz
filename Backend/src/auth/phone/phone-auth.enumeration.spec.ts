// LOW-PLT-011: the public phone endpoints answer the same for a number that has
// an account and one that does not.

import { OtpChannel } from '@prisma/client';
import { PhoneAuthService } from './phone-auth.service';

function build() {
  const prisma = { appUser: { findUnique: jest.fn() } };
  const otp = {
    request: jest.fn().mockResolvedValue({
      requestId: 'otp_1',
      expiresAt: new Date('2026-11-10T10:05:00.000Z'),
      resendAfterSeconds: 60,
      otpLength: 6,
      channel: OtpChannel.SMS,
    }),
  };
  const service = new PhoneAuthService(
    prisma as never,
    otp as never,
    {} as never,
    {} as never,
  );
  return { service, prisma, otp };
}

describe('phone enumeration', () => {
  it('request-otp returns an identical body for a registered and an unknown number, without looking either up', async () => {
    const { service, prisma } = build();
    prisma.appUser.findUnique.mockResolvedValue({ id: 'usr_1' });
    const known = await service.requestOtp({
      phone_e164: '+998901234567',
    } as never);
    prisma.appUser.findUnique.mockResolvedValue(null);
    const unknown = await service.requestOtp({
      phone_e164: '+998901234567',
    } as never);

    expect(known).toEqual(unknown);
    expect(known).not.toHaveProperty('is_existing_user');
    // No lookup at all: nothing to time, either.
    expect(prisma.appUser.findUnique).not.toHaveBeenCalled();
    // The fields the app reads are all still there.
    expect(known).toMatchObject({
      request_id: 'otp_1',
      phone_e164: '+998901234567',
      resend_after_seconds: 60,
      otp_length: 6,
      delivery_channel: 'sms',
      next_screen: 'AuthOtpVerifyScreen',
    });
  });

  it('check-availability says nothing about the number', () => {
    const { service, prisma } = build();
    expect(service.checkAvailability('+998901234567')).toEqual({
      phone_e164: '+998901234567',
    });
    expect(prisma.appUser.findUnique).not.toHaveBeenCalled();
  });

  it('the resend interval the response reports is the 60-second cooldown', async () => {
    const { service } = build();
    const res = await service.requestOtp({
      phone_e164: '+998901234567',
    } as never);
    expect(res.resend_after_seconds).toBe(60);
  });
});
