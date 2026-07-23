// Unit tests for PhoneChangeService (change-phone flow). Prisma, OtpService and
// TokenService are mocked. These guard: no-op rejection (same number), taken-by-
// another-user rejection, OTP isolation (phone_change purpose), full field
// update on confirm, and session revocation after a successful change.

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { OtpChannel } from '@prisma/client';
import { PhoneChangeService } from './phone-change.service';
import { OtpPurpose } from '../auth/phone/otp.service';

function makePrisma() {
  return {
    appUser: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };
}

function makeOtp() {
  return {
    request: jest.fn().mockResolvedValue({
      requestId: 'otp_1',
      expiresAt: new Date('2026-07-23T10:05:00.000Z'),
      resendAfterSeconds: 60,
      otpLength: 6,
      channel: OtpChannel.SMS,
    }),
    verifyLatestForPhone: jest.fn().mockResolvedValue(undefined),
  };
}

function makeTokens() {
  return {
    revokeAllForUser: jest.fn().mockResolvedValue(undefined),
    issueSession: jest.fn().mockResolvedValue({
      accessToken: 'access.jwt',
      accessTokenExpiresAt: new Date('2026-07-23T11:00:00.000Z'),
      refreshToken: 'rt_new',
      refreshTokenExpiresAt: new Date('2026-10-21T10:00:00.000Z'),
      tokenType: 'Bearer',
    }),
  };
}

function build() {
  const prisma = makePrisma();
  const otp = makeOtp();
  const tokens = makeTokens();
  const service = new PhoneChangeService(
    prisma as never,
    otp as never,
    tokens as never,
  );
  return { service, prisma, otp, tokens };
}

const CURRENT = '+998900000000';
const NEW = '+998901234567';

describe('PhoneChangeService', () => {
  describe('request()', () => {
    it('issues a phone_change OTP for an available number', async () => {
      const { service, prisma, otp } = build();
      prisma.appUser.findUnique
        .mockResolvedValueOnce({ id: 'u1', phoneE164: CURRENT }) // caller
        .mockResolvedValueOnce(null); // availability check: nobody owns NEW

      const res = await service.request('u1', NEW);

      expect(otp.request).toHaveBeenCalledWith(
        NEW,
        OtpChannel.SMS,
        OtpPurpose.PHONE_CHANGE,
      );
      expect(res.phone).toBe(NEW);
      expect(res.otp_length).toBe(6);
      expect(res.delivery_channel).toBe('sms');
    });

    it('rejects when the new number equals the current one', async () => {
      const { service, prisma, otp } = build();
      prisma.appUser.findUnique.mockResolvedValueOnce({
        id: 'u1',
        phoneE164: NEW,
      });

      await expect(service.request('u1', NEW)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(otp.request).not.toHaveBeenCalled();
    });

    it('rejects when the number belongs to another user', async () => {
      const { service, prisma, otp } = build();
      prisma.appUser.findUnique
        .mockResolvedValueOnce({ id: 'u1', phoneE164: CURRENT })
        .mockResolvedValueOnce({ id: 'someone_else', phoneE164: NEW });

      await expect(service.request('u1', NEW)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(otp.request).not.toHaveBeenCalled();
    });

    it('404s for an unknown caller', async () => {
      const { service, prisma } = build();
      prisma.appUser.findUnique.mockResolvedValueOnce(null);
      await expect(service.request('ghost', NEW)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('normalizes an input with spaces/dashes to canonical E.164', async () => {
      const { service, prisma, otp } = build();
      prisma.appUser.findUnique
        .mockResolvedValueOnce({ id: 'u1', phoneE164: CURRENT })
        .mockResolvedValueOnce(null);

      await service.request('u1', '+998 90 123-45-67');
      expect(otp.request).toHaveBeenCalledWith(
        NEW,
        OtpChannel.SMS,
        OtpPurpose.PHONE_CHANGE,
      );
    });
  });

  describe('confirm()', () => {
    it('verifies the OTP, updates all phone fields, rotates tokens (revoke → issue) and returns a fresh pair', async () => {
      const { service, prisma, otp, tokens } = build();
      prisma.appUser.findUnique
        .mockResolvedValueOnce({ id: 'u1', phoneE164: CURRENT }) // caller
        .mockResolvedValueOnce(null); // availability re-check
      prisma.appUser.update.mockResolvedValue({
        id: 'u1',
        phoneE164: NEW,
        phoneVerified: true,
        email: null,
        emailVerified: false,
        displayName: null,
        firstName: null,
        lastName: null,
        avatarUrl: null,
        thumbnailUrl: null,
        role: 'USER',
        language: 'UZ',
        myIdStatus: 'NOT_VERIFIED',
        transactionLimitUzs: 0,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-07-23T10:00:00Z'),
      });

      const res = await service.confirm('u1', NEW, '123456');

      expect(otp.verifyLatestForPhone).toHaveBeenCalledWith(
        NEW,
        '123456',
        OtpPurpose.PHONE_CHANGE,
      );
      expect(prisma.appUser.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { phoneE164: NEW, phoneVerified: true },
      });
      // Revoke the old family, THEN issue a new pair for the same user.
      expect(tokens.revokeAllForUser).toHaveBeenCalledWith('u1');
      expect(tokens.issueSession).toHaveBeenCalledWith({
        id: 'u1',
        email: null,
        role: 'USER',
      });
      const revokeOrder = tokens.revokeAllForUser.mock.invocationCallOrder[0];
      const issueOrder = tokens.issueSession.mock.invocationCallOrder[0];
      expect(revokeOrder).toBeLessThan(issueOrder);

      // Returns updated user + a fresh snake_case token envelope.
      expect(res.user.phone_e164).toBe(NEW);
      expect(res.user.phone_verified).toBe(true);
      expect(res.tokens).toEqual({
        access_token: 'access.jwt',
        access_token_expires_at: '2026-07-23T11:00:00.000Z',
        refresh_token: 'rt_new',
        refresh_token_expires_at: '2026-10-21T10:00:00.000Z',
        token_type: 'Bearer',
      });
    });

    it('does not update or revoke when the OTP is invalid', async () => {
      const { service, prisma, otp, tokens } = build();
      prisma.appUser.findUnique.mockResolvedValueOnce({
        id: 'u1',
        phoneE164: CURRENT,
      });
      otp.verifyLatestForPhone.mockRejectedValue(
        new BadRequestException('bad'),
      );

      await expect(service.confirm('u1', NEW, '000000')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.appUser.update).not.toHaveBeenCalled();
      expect(tokens.revokeAllForUser).not.toHaveBeenCalled();
      expect(tokens.issueSession).not.toHaveBeenCalled();
    });

    it('rejects when the number was claimed between request and confirm', async () => {
      const { service, prisma, tokens } = build();
      prisma.appUser.findUnique
        .mockResolvedValueOnce({ id: 'u1', phoneE164: CURRENT }) // caller
        .mockResolvedValueOnce({ id: 'other', phoneE164: NEW }); // now taken

      await expect(service.confirm('u1', NEW, '123456')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.appUser.update).not.toHaveBeenCalled();
      expect(tokens.revokeAllForUser).not.toHaveBeenCalled();
      expect(tokens.issueSession).not.toHaveBeenCalled();
    });

    it('rejects a no-op confirm (already the current number)', async () => {
      const { service, prisma, otp } = build();
      prisma.appUser.findUnique.mockResolvedValueOnce({
        id: 'u1',
        phoneE164: NEW,
      });

      await expect(service.confirm('u1', NEW, '123456')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(otp.verifyLatestForPhone).not.toHaveBeenCalled();
    });
  });
});
