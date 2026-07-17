// Unit tests for OtpService's AUTH_DEV_MODE behaviour. Prisma, SmsService and
// ConfigService are mocked — no DB, no real SMS. The focus is the dev-mode
// switch: generation/persistence must be identical to production, only the
// delivery + returned code change. verify() is exercised end-to-end against the
// stored hash to prove the security path is untouched by the dev-mode work.

import { OtpChannel } from '@prisma/client';
import { OtpService } from './otp.service';

function makePrismaMock() {
  return {
    phoneOtpRequest: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
  };
}

function makeSmsMock() {
  return { sendSms: jest.fn().mockResolvedValue(undefined) };
}

function makeConfig(devMode: boolean) {
  return {
    get: jest.fn((key: string) => (key === 'AUTH_DEV_MODE' ? (devMode ? 'true' : 'false') : undefined)),
  };
}

function build(devMode: boolean) {
  const prisma = makePrismaMock();
  const sms = makeSmsMock();
  const config = makeConfig(devMode);
  // create() echoes back the row it was given plus a fixed id.
  prisma.phoneOtpRequest.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'otp_test', ...data }),
  );
  const service = new OtpService(prisma as never, sms as never, config as never);
  return { service, prisma, sms, config };
}

describe('OtpService — AUTH_DEV_MODE', () => {
  describe('request()', () => {
    it('development mode skips SMS sending and returns dev_otp_code', async () => {
      const { service, prisma, sms } = build(true);

      const issued = await service.request('+998901234567');

      // OTP still generated + persisted exactly as in production.
      expect(prisma.phoneOtpRequest.create).toHaveBeenCalledTimes(1);
      const persisted = prisma.phoneOtpRequest.create.mock.calls[0][0].data;
      expect(persisted.codeHash).toEqual(expect.any(String));
      expect(persisted.phoneE164).toBe('+998901234567');

      // SMS provider is NOT called.
      expect(sms.sendSms).not.toHaveBeenCalled();

      // Plaintext code is returned, is 6 digits, and its hash matches storage.
      expect(issued.devOtpCode).toMatch(/^\d{6}$/);
      const { createHash } = require('crypto') as typeof import('crypto');
      expect(createHash('sha256').update(issued.devOtpCode!).digest('hex')).toBe(persisted.codeHash);
    });

    it('production mode still calls SmsService and never returns dev_otp_code', async () => {
      const { service, prisma, sms } = build(false);

      const issued = await service.request('+998901234567');

      expect(prisma.phoneOtpRequest.create).toHaveBeenCalledTimes(1);
      expect(sms.sendSms).toHaveBeenCalledTimes(1);
      // Message carries the plaintext code but it is never exposed on the result.
      expect(sms.sendSms.mock.calls[0][0]).toBe('+998901234567');
      expect(issued.devOtpCode).toBeUndefined();
    });
  });

  describe('resend()', () => {
    const existing = {
      id: 'otp_test',
      phoneE164: '+998901234567',
      channel: OtpChannel.SMS,
      consumedAt: null,
      // Cooldown already elapsed so resend is allowed.
      lastSentAt: new Date(Date.now() - 10 * 60 * 1000),
    };

    it('development mode regenerates, updates DB, skips SMS, returns dev_otp_code', async () => {
      const { service, prisma, sms } = build(true);
      prisma.phoneOtpRequest.findUnique.mockResolvedValue({ ...existing });

      const issued = await service.resend('otp_test');

      // DB updated with a fresh hash (persistence path unchanged).
      expect(prisma.phoneOtpRequest.update).toHaveBeenCalledTimes(1);
      const updated = prisma.phoneOtpRequest.update.mock.calls[0][0].data;
      expect(updated.codeHash).toEqual(expect.any(String));

      // SMS skipped, plaintext returned and consistent with the stored hash.
      expect(sms.sendSms).not.toHaveBeenCalled();
      expect(issued.devOtpCode).toMatch(/^\d{6}$/);
      const { createHash } = require('crypto') as typeof import('crypto');
      expect(createHash('sha256').update(issued.devOtpCode!).digest('hex')).toBe(updated.codeHash);
    });

    it('production mode still calls SmsService and never returns dev_otp_code', async () => {
      const { service, prisma, sms } = build(false);
      prisma.phoneOtpRequest.findUnique.mockResolvedValue({ ...existing });

      const issued = await service.resend('otp_test');

      expect(prisma.phoneOtpRequest.update).toHaveBeenCalledTimes(1);
      expect(sms.sendSms).toHaveBeenCalledTimes(1);
      expect(issued.devOtpCode).toBeUndefined();
    });
  });

  describe('verify() — unchanged by dev mode', () => {
    it('accepts the stored OTP and consumes the request', async () => {
      // Issue in dev mode to get the plaintext, capture the persisted hash, then
      // verify against it — proves the stored OTP is still the source of truth.
      const { service, prisma } = build(true);

      const issued = await service.request('+998901234567');
      const persisted = prisma.phoneOtpRequest.create.mock.calls[0][0].data;

      prisma.phoneOtpRequest.findUnique.mockResolvedValue({
        id: 'otp_test',
        phoneE164: '+998901234567',
        codeHash: persisted.codeHash,
        consumedAt: null,
        attempts: 0,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      });

      await expect(
        service.verify('otp_test', '+998901234567', issued.devOtpCode!),
      ).resolves.toBeUndefined();

      // Request marked consumed exactly as before.
      const last = prisma.phoneOtpRequest.update.mock.calls.at(-1)![0];
      expect(last.data.consumedAt).toEqual(expect.any(Date));
    });

    it('rejects an incorrect code and increments attempts', async () => {
      const { service, prisma } = build(true);
      prisma.phoneOtpRequest.findUnique.mockResolvedValue({
        id: 'otp_test',
        phoneE164: '+998901234567',
        codeHash: 'a'.repeat(64), // hash of nothing the caller will supply
        consumedAt: null,
        attempts: 0,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      });

      await expect(service.verify('otp_test', '+998901234567', '000000')).rejects.toThrow();
      const last = prisma.phoneOtpRequest.update.mock.calls.at(-1)![0];
      expect(last.data.attempts).toEqual({ increment: 1 });
    });
  });
});
