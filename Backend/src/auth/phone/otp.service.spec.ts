// Unit tests for OtpService. The persistence layer is now Redis: RedisService,
// SmsService and ConfigService are mocked — no DB, no real SMS, no live Redis.
// The RedisService double is backed by an in-memory map (with TTL bookkeeping)
// so the full issue -> resend -> verify lifecycle can be exercised end-to-end.
// Focus: AUTH_DEV_MODE behaviour, single-use consume, attempt counting, purpose
// isolation and the phone-keyed lookups — all identical to the previous DB path.

import { OtpChannel } from '@prisma/client';
import { OtpService, OtpPurpose } from './otp.service';
import { FixedWindowRateLimiter } from '../../redis/rate-limiter.service';
import { RedisKeys } from '../../redis/redis.keys';

/**
 * Minimal in-memory RedisService stand-in. Values are stored JSON-parsed (as the
 * real `get` returns), TTLs are tracked but not auto-expired — tests drive
 * expiry explicitly where needed.
 */
function makeRedisMock() {
  const store = new Map<string, unknown>();
  const ttls = new Map<string, number>();
  return {
    store,
    ttls,
    get: jest.fn(async (key: string) =>
      store.has(key) ? store.get(key) : null,
    ),
    setEx: jest.fn(async (key: string, ttl: number, value: unknown) => {
      // Emulate the real service: JSON round-trip so callers get a plain object.
      store.set(key, JSON.parse(JSON.stringify(value)));
      ttls.set(key, ttl);
      return 'OK' as const;
    }),
    del: jest.fn(async (key: string) => {
      const existed = store.delete(key) ? 1 : 0;
      ttls.delete(key);
      return existed;
    }),
    incr: jest.fn(async (key: string) => {
      const next = ((store.get(key) as number) ?? 0) + 1;
      store.set(key, next);
      return next;
    }),
    expire: jest.fn(async (key: string, ttl: number) => {
      if (!store.has(key)) return false;
      ttls.set(key, ttl);
      return true;
    }),
    ttl: jest.fn(async (key: string) => ttls.get(key) ?? -2),
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
  const redis = makeRedisMock();
  const sms = makeSmsMock();
  const config = makeConfig(devMode);
  // Real FixedWindowRateLimiter backed by the same in-memory Redis double, so the
  // hourly ceiling is exercised through the shared infrastructure end-to-end.
  const rateLimiter = new FixedWindowRateLimiter(redis as never);
  const service = new OtpService(redis as never, sms as never, config as never, rateLimiter);
  return { service, redis, sms, config, rateLimiter };
}

/** The record stored under RedisKeys.otp(phone) after an issue. */
function storedRecord(redis: ReturnType<typeof makeRedisMock>, phone: string) {
  return redis.store.get(RedisKeys.otp(phone)) as {
    requestId: string;
    codeHash: string;
    attempts: number;
    createdAt: number;
    expiresAt: number;
    purpose: string;
  };
}

describe('OtpService — AUTH_DEV_MODE', () => {
  describe('request()', () => {
    it('development mode skips SMS sending and returns dev_otp_code', async () => {
      const { service, redis, sms } = build(true);

      const issued = await service.request('+998901234567');

      // OTP still generated + persisted (now to Redis) exactly as before.
      const persisted = storedRecord(redis, '+998901234567');
      expect(persisted.codeHash).toEqual(expect.any(String));
      expect(persisted.createdAt).toEqual(expect.any(Number));
      expect(persisted.attempts).toBe(0);

      // SMS provider is NOT called.
      expect(sms.sendSms).not.toHaveBeenCalled();

      // Plaintext code is returned, is 6 digits, and its hash matches storage.
      expect(issued.devOtpCode).toMatch(/^\d{6}$/);
      const { createHash } = require('crypto') as typeof import('crypto');
      expect(createHash('sha256').update(issued.devOtpCode!).digest('hex')).toBe(persisted.codeHash);
    });

    it('production mode still calls SmsService and never returns dev_otp_code', async () => {
      const { service, sms } = build(false);

      const issued = await service.request('+998901234567');

      expect(sms.sendSms).toHaveBeenCalledTimes(1);
      // Message carries the plaintext code but it is never exposed on the result.
      expect(sms.sendSms.mock.calls[0][0]).toBe('+998901234567');
      expect(issued.devOtpCode).toBeUndefined();
    });

    it('enforces the per-hour ceiling (6th request in the window is rejected)', async () => {
      const { service } = build(false);
      for (let i = 0; i < 5; i++) {
        await service.request(`+99890000000${i}`.slice(0, 13));
      }
      // Same MSISDN, 6 issues -> the 6th trips MAX_PER_HOUR.
      const phone = '+998905555555';
      for (let i = 0; i < 5; i++) await service.request(phone);
      await expect(service.request(phone)).rejects.toThrow(
        'Too many OTP requests. Please try again later.',
      );
    });
  });

  describe('resend()', () => {
    it('development mode regenerates, updates Redis, skips SMS, returns dev_otp_code', async () => {
      const { service, redis, sms } = build(true);
      const first = await service.request('+998901234567');
      const beforeHash = storedRecord(redis, '+998901234567').codeHash;
      sms.sendSms.mockClear();

      // Elapse the cooldown by rewriting lastSentAt into the past.
      const rec = storedRecord(redis, '+998901234567') as Record<string, unknown>;
      rec.lastSentAt = Date.now() - 10 * 60 * 1000;
      redis.store.set(RedisKeys.otp('+998901234567'), rec);

      const issued = await service.resend(first.requestId);

      // Fresh hash written back (persistence path unchanged), same request_id.
      const afterHash = storedRecord(redis, '+998901234567').codeHash;
      expect(afterHash).toEqual(expect.any(String));
      expect(afterHash).not.toBe(beforeHash);
      expect(issued.requestId).toBe(first.requestId);

      // SMS skipped, plaintext returned and consistent with the stored hash.
      expect(sms.sendSms).not.toHaveBeenCalled();
      expect(issued.devOtpCode).toMatch(/^\d{6}$/);
      const { createHash } = require('crypto') as typeof import('crypto');
      expect(createHash('sha256').update(issued.devOtpCode!).digest('hex')).toBe(afterHash);
    });

    it('enforces the resend cooldown', async () => {
      const { service } = build(false);
      const first = await service.request('+998901234567');
      // Immediately resending (cooldown not elapsed) is rejected.
      await expect(service.resend(first.requestId)).rejects.toThrow(/before requesting a new code/);
    });

    it('rejects an unknown/consumed request_id', async () => {
      const { service } = build(false);
      await expect(service.resend('otp_nope')).rejects.toThrow(
        'Invalid or already-used OTP request',
      );
    });

    it('production mode still calls SmsService and never returns dev_otp_code', async () => {
      const { service, redis, sms } = build(false);
      const first = await service.request('+998901234567');
      sms.sendSms.mockClear();
      const rec = storedRecord(redis, '+998901234567') as Record<string, unknown>;
      rec.lastSentAt = Date.now() - 10 * 60 * 1000;
      redis.store.set(RedisKeys.otp('+998901234567'), rec);

      const issued = await service.resend(first.requestId);

      expect(sms.sendSms).toHaveBeenCalledTimes(1);
      expect(issued.devOtpCode).toBeUndefined();
    });
  });

  describe('verify()', () => {
    it('accepts the stored OTP and consumes the request (deletes the key)', async () => {
      const { service, redis } = build(true);
      const issued = await service.request('+998901234567');

      await expect(
        service.verify(issued.requestId, '+998901234567', issued.devOtpCode!),
      ).resolves.toBeUndefined();

      // Single-use: both the phone key and the request pointer are gone.
      expect(redis.store.has(RedisKeys.otp('+998901234567'))).toBe(false);
      expect(redis.store.has(RedisKeys.otpRequest(issued.requestId))).toBe(false);
    });

    it('rejects a concurrent double-submit (second consume deletes 0 keys)', async () => {
      const { service } = build(true);
      const issued = await service.request('+998901234567');

      const [a, b] = await Promise.allSettled([
        service.verify(issued.requestId, '+998901234567', issued.devOtpCode!),
        service.verify(issued.requestId, '+998901234567', issued.devOtpCode!),
      ]);
      const outcomes = [a.status, b.status].sort();
      // Exactly one wins; the other is rejected.
      expect(outcomes).toEqual(['fulfilled', 'rejected']);
    });

    it('rejects an incorrect code and increments attempts', async () => {
      const { service, redis } = build(true);
      const issued = await service.request('+998901234567');

      await expect(
        service.verify(issued.requestId, '+998901234567', '000000'),
      ).rejects.toThrow('Incorrect verification code');

      expect(storedRecord(redis, '+998901234567').attempts).toBe(1);
    });

    it('rejects after MAX_ATTEMPTS incorrect guesses', async () => {
      const { service, redis } = build(true);
      const issued = await service.request('+998901234567');
      // Force the attempt counter to the ceiling.
      const rec = storedRecord(redis, '+998901234567') as Record<string, unknown>;
      rec.attempts = 5;
      redis.store.set(RedisKeys.otp('+998901234567'), rec);

      await expect(
        service.verify(issued.requestId, '+998901234567', issued.devOtpCode!),
      ).rejects.toThrow('Too many incorrect attempts. Please request a new code.');
    });

    it('rejects an expired code with the expiry message (before TTL reaps it)', async () => {
      const { service, redis } = build(true);
      const issued = await service.request('+998901234567');
      const rec = storedRecord(redis, '+998901234567') as Record<string, unknown>;
      rec.expiresAt = Date.now() - 1000; // logically expired, key still present
      redis.store.set(RedisKeys.otp('+998901234567'), rec);

      await expect(
        service.verify(issued.requestId, '+998901234567', issued.devOtpCode!),
      ).rejects.toThrow('Verification code has expired. Please request a new one.');
    });
  });

  describe('purpose isolation (phone change vs login)', () => {
    it('request() persists the given purpose', async () => {
      const { service, redis } = build(false);
      await service.request('+998901234567', OtpChannel.SMS, OtpPurpose.PHONE_CHANGE);
      expect(storedRecord(redis, '+998901234567').purpose).toBe('phone_change');
    });

    it('verify() rejects a code whose stored purpose does not match', async () => {
      const { service } = build(true);
      // Minted for login; a phone-change verify must not redeem it.
      const issued = await service.request('+998901234567', OtpChannel.SMS, OtpPurpose.LOGIN);
      await expect(
        service.verify(issued.requestId, '+998901234567', issued.devOtpCode!, OtpPurpose.PHONE_CHANGE),
      ).rejects.toThrow('Invalid or already-used verification request');
    });

    it('verifyLatestForPhone() resolves the record and consumes it', async () => {
      const { service, redis } = build(true);
      const issued = await service.request('+998901234567', OtpChannel.SMS, OtpPurpose.PHONE_CHANGE);

      await expect(
        service.verifyLatestForPhone('+998901234567', issued.devOtpCode!, OtpPurpose.PHONE_CHANGE),
      ).resolves.toBeUndefined();

      expect(redis.store.has(RedisKeys.otp('+998901234567'))).toBe(false);
    });

    it('verifyLatestForPhone() throws when no active request exists', async () => {
      const { service } = build(false);
      await expect(
        service.verifyLatestForPhone('+998901234567', '123456', OtpPurpose.PHONE_CHANGE),
      ).rejects.toThrow('No active verification request for this phone. Please request a new code.');
    });

    it('verifyLatestForPhone() throws when the active request has a different purpose', async () => {
      const { service } = build(true);
      await service.request('+998901234567', OtpChannel.SMS, OtpPurpose.LOGIN);
      await expect(
        service.verifyLatestForPhone('+998901234567', '123456', OtpPurpose.PHONE_CHANGE),
      ).rejects.toThrow('No active verification request for this phone. Please request a new code.');
    });
  });
});
