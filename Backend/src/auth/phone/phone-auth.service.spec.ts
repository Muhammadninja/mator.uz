// Unit tests for PhoneAuthService's dev_otp_code passthrough. OtpService,
// Prisma and TokenService are mocked. The contract under test: dev_otp_code is
// present in the requestOtp/resendOtp response iff OtpService returned a
// devOtpCode, and absent otherwise (production). The rest of the response shape
// is asserted to remain unchanged.

import { OtpChannel } from '@prisma/client';
import { PhoneAuthService } from './phone-auth.service';

function makeOtpMock(devOtpCode?: string) {
  const issued = {
    requestId: 'otp_test',
    expiresAt: new Date('2026-07-17T00:05:00.000Z'),
    resendAfterSeconds: 60,
    otpLength: 6,
    channel: OtpChannel.SMS,
    devOtpCode,
  };
  return {
    request: jest.fn().mockResolvedValue(issued),
    resend: jest.fn().mockResolvedValue(issued),
  };
}

function makePrismaMock() {
  return { appUser: { findUnique: jest.fn().mockResolvedValue(null) } };
}

function build(devOtpCode?: string) {
  const otp = makeOtpMock(devOtpCode);
  const prisma = makePrismaMock();
  const tokens = {} as never;
  const service = new PhoneAuthService(prisma as never, otp as never, tokens);
  return { service, otp, prisma };
}

describe('PhoneAuthService — dev_otp_code passthrough', () => {
  describe('requestOtp()', () => {
    it('includes dev_otp_code when OtpService returns one (dev mode)', async () => {
      const { service } = build('123456');

      const res = await service.requestOtp({ phone_e164: '+998901234567' } as never);

      expect(res).toMatchObject({
        request_id: 'otp_test',
        phone_e164: '+998901234567',
        otp_length: 6,
        delivery_channel: 'sms',
        next_screen: 'AuthOtpVerifyScreen',
        dev_otp_code: '123456',
      });
    });

    it('omits dev_otp_code in production (OtpService returns undefined)', async () => {
      const { service } = build(undefined);

      const res = await service.requestOtp({ phone_e164: '+998901234567' } as never);

      expect(res).not.toHaveProperty('dev_otp_code');
      // Existing contract fields still present.
      expect(res.request_id).toBe('otp_test');
      expect(res.next_screen).toBe('AuthOtpVerifyScreen');
    });
  });

  describe('resendOtp()', () => {
    it('includes dev_otp_code when OtpService returns one (dev mode)', async () => {
      const { service } = build('654321');

      const res = await service.resendOtp('otp_test');

      expect(res).toMatchObject({ request_id: 'otp_test', dev_otp_code: '654321' });
    });

    it('omits dev_otp_code in production', async () => {
      const { service } = build(undefined);

      const res = await service.resendOtp('otp_test');

      expect(res).not.toHaveProperty('dev_otp_code');
      expect(res.request_id).toBe('otp_test');
    });
  });
});
