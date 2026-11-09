// SEC-001: the OTP attempt limits under concurrency and across request ids. The
// real FixedWindowRateLimiter runs over an in-memory Redis whose every command
// yields to the event loop, so concurrent verifications really do interleave.
import { HttpException } from '@nestjs/common';
import { OtpService, OtpPurpose, otpCooldownPhone } from './otp.service';
import { FixedWindowRateLimiter } from '../../redis/rate-limiter.service';
import { RedisKeys } from '../../redis/redis.keys';

const PHONE = '+998901234567';
const WRONG = '000000';
const tick = () => new Promise((resolve) => setImmediate(resolve));

function makeRedis() {
  const store = new Map<string, unknown>();
  const ttls = new Map<string, number>();
  return {
    store,
    ttls,
    get: jest.fn(async (key: string) => {
      await tick();
      return store.has(key) ? store.get(key) : null;
    }),
    setNxEx: jest.fn(async (key: string, ttl: number, claim: string) => {
      if (store.has(key)) return false;
      store.set(key, claim);
      ttls.set(key, ttl);
      return true;
    }),
    evalScript: jest.fn(async (_s: string, keys: string[], args: string[]) =>
      store.get(keys[0]) === args[0] ? (store.delete(keys[0]), 1) : 0,
    ),
    setEx: jest.fn(async (key: string, ttl: number, value: unknown) => {
      await tick();
      store.set(key, JSON.parse(JSON.stringify(value)));
      ttls.set(key, ttl);
      return 'OK' as const;
    }),
    del: jest.fn(async (key: string) => {
      await tick();
      return store.delete(key) ? 1 : 0;
    }),
    incr: jest.fn(async (key: string) => {
      await tick();
      const next = ((store.get(key) as number) ?? 0) + 1;
      store.set(key, next);
      return next;
    }),
    expire: jest.fn(async (key: string, ttl: number) => {
      await tick();
      if (!store.has(key)) return false;
      ttls.set(key, ttl);
      return true;
    }),
    ttl: jest.fn(async (key: string) => ttls.get(key) ?? -2),
  };
}

function build() {
  const redis = makeRedis();
  const config = {
    get: jest.fn((key: string) =>
      key === 'AUTH_DEV_MODE' ? 'true' : undefined,
    ),
  };
  const rateLimiter = new FixedWindowRateLimiter(redis as never);
  const service = new OtpService(
    redis as never,
    { enqueueOtpSms: jest.fn(), otpSmsJobId: jest.fn() } as never,
    config as never,
    rateLimiter,
  );
  return { service, redis, rateLimiter };
}

/** Counts comparisons: `hash` runs once per comparison after the code is issued. */
function countComparisons(service: OtpService) {
  return jest.spyOn(service as unknown as { hash(c: string): string }, 'hash');
}

const statusOf = (result: PromiseSettledResult<void>): number | 'ok' => {
  if (result.status === 'fulfilled') return 'ok';
  return (result.reason as HttpException).getStatus();
};

/** A phone's next request after the resend cooldown has passed. */
function allowResend(redis: ReturnType<typeof makeRedis>) {
  redis.store.delete(RedisKeys.otpSendCooldown(otpCooldownPhone(PHONE)));
}

describe('OTP attempt limits (SEC-001)', () => {
  it('compares at most five codes out of 50 concurrent wrong guesses', async () => {
    const { service } = build();
    const issued = await service.request(PHONE);
    const comparisons = countComparisons(service);

    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        service.verify(issued.requestId, PHONE, WRONG),
      ),
    );

    expect(comparisons).toHaveBeenCalledTimes(5);
    expect(results.filter((r) => statusOf(r) === 401)).toHaveLength(5);
    expect(results.filter((r) => statusOf(r) === 429)).toHaveLength(45);
  });

  it('refuses the sixth attempt', async () => {
    const { service } = build();
    const issued = await service.request(PHONE);
    for (let i = 0; i < 5; i++) {
      await expect(
        service.verify(issued.requestId, PHONE, WRONG),
      ).rejects.toThrow('Incorrect verification code');
    }
    await expect(
      service.verify(issued.requestId, PHONE, WRONG),
    ).rejects.toThrow('Too many incorrect attempts');
  });

  it('refuses the correct code once the counter is exhausted', async () => {
    const { service } = build();
    const issued = await service.request(PHONE);
    for (let i = 0; i < 5; i++) {
      await service
        .verify(issued.requestId, PHONE, WRONG)
        .catch(() => undefined);
    }
    const comparisons = countComparisons(service);

    await expect(
      service.verify(issued.requestId, PHONE, issued.devOtpCode!),
    ).rejects.toThrow('Too many incorrect attempts');
    expect(comparisons).not.toHaveBeenCalled();
  });

  it('still accepts the correct code within the five attempts', async () => {
    const { service } = build();
    const issued = await service.request(PHONE);
    for (let i = 0; i < 4; i++) {
      await service
        .verify(issued.requestId, PHONE, WRONG)
        .catch(() => undefined);
    }
    await expect(
      service.verify(issued.requestId, PHONE, issued.devOtpCode!),
    ).resolves.toBeUndefined();
  });

  it('arms the counter for the life of the OTP record', async () => {
    const { service, redis } = build();
    const issued = await service.request(PHONE);
    await service.verify(issued.requestId, PHONE, WRONG).catch(() => undefined);

    expect(redis.ttls.get(RedisKeys.otpAttempts(issued.requestId))).toBe(
      redis.ttls.get(RedisKeys.otp(PHONE)),
    );
  });

  it('shares the per-phone limit across request ids', async () => {
    const { service, redis } = build();
    const comparisons = countComparisons(service);
    // Three requests x up to five attempts: only ten comparisons are allowed.
    for (let round = 0; round < 3; round++) {
      allowResend(redis);
      const issued = await service.request(PHONE);
      comparisons.mockClear();
      await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          service.verify(issued.requestId, PHONE, WRONG),
        ),
      );
      expect(comparisons.mock.calls.length).toBe(round < 2 ? 5 : 0);
    }
  });

  it('a made-up request id does not cost the phone anything', async () => {
    const { service, redis } = build();
    await service.request(PHONE);
    await expect(service.verify('otp_nope', PHONE, WRONG)).rejects.toThrow(
      'Invalid or already-used',
    );
    expect(redis.store.has(RedisKeys.rateOtpVerify(PHONE))).toBe(false);
  });

  it('applies the same limits to the phone-confirmation flow', async () => {
    const { service } = build();
    await service.request(PHONE, undefined, OtpPurpose.PHONE_CHANGE);
    const comparisons = countComparisons(service);

    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        service.verifyLatestForPhone(PHONE, WRONG, OtpPurpose.PHONE_CHANGE),
      ),
    );

    expect(comparisons).toHaveBeenCalledTimes(5);
    expect(results.filter((r) => statusOf(r) === 429)).toHaveLength(45);
  });

  describe('resend', () => {
    it('does not hand the request a fresh five attempts', async () => {
      const { service, redis } = build();
      const issued = await service.request(PHONE);
      for (let i = 0; i < 3; i++) {
        await service
          .verify(issued.requestId, PHONE, WRONG)
          .catch(() => undefined);
      }
      allowResend(redis);
      const resent = await service.resend(issued.requestId);
      const comparisons = countComparisons(service);

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          service.verify(resent.requestId, PHONE, WRONG),
        ),
      );

      expect(comparisons).toHaveBeenCalledTimes(2);
      expect(results.filter((r) => statusOf(r) === 429)).toHaveLength(8);
    });

    it('sends no SMS for a request whose attempts are spent', async () => {
      const { service, redis } = build();
      const issued = await service.request(PHONE);
      redis.store.set(RedisKeys.otpAttempts(issued.requestId), 5);
      allowResend(redis);

      await expect(service.resend(issued.requestId)).rejects.toThrow(
        'Too many incorrect attempts',
      );
    });

    it('keeps the counter alive for as long as the new code', async () => {
      const { service, redis } = build();
      const issued = await service.request(PHONE);
      await service
        .verify(issued.requestId, PHONE, WRONG)
        .catch(() => undefined);
      redis.ttls.set(RedisKeys.otpAttempts(issued.requestId), 5);
      allowResend(redis);

      await service.resend(issued.requestId);

      expect(redis.ttls.get(RedisKeys.otpAttempts(issued.requestId))).toBe(
        redis.ttls.get(RedisKeys.otp(PHONE)),
      );
    });
  });

  describe('when Redis fails', () => {
    it('refuses the guess with a 503 and compares nothing', async () => {
      const { service, redis } = build();
      const issued = await service.request(PHONE);
      redis.incr.mockRejectedValue(new Error('connection lost'));
      const comparisons = countComparisons(service);

      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () =>
          service.verify(issued.requestId, PHONE, issued.devOtpCode!),
        ),
      );

      expect(results.every((r) => statusOf(r) === 503)).toBe(true);
      expect(comparisons).not.toHaveBeenCalled();
    });

    it('refuses when Redis stops answering', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      try {
        const { service, redis } = build();
        const issued = await service.request(PHONE);
        redis.incr.mockReturnValue(new Promise(() => undefined));
        const comparisons = countComparisons(service);

        const pending = service.verify(issued.requestId, PHONE, WRONG);
        const outcome = expect(pending).rejects.toThrow(
          'temporarily unavailable',
        );
        await tick();
        await tick();
        await jest.advanceTimersByTimeAsync(2_000);
        await outcome;
        expect(comparisons).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
