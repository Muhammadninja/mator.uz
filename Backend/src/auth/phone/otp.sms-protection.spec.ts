// SEC-006: the one limit on sending, a 60-second cooldown per phone number.
import { HttpException } from '@nestjs/common';
import { OtpService, OtpPurpose, otpCooldownPhone } from './otp.service';
import { FixedWindowRateLimiter } from '../../redis/rate-limiter.service';
import { RedisKeys } from '../../redis/redis.keys';
import {
  RedisTimeoutError,
  RedisUnavailableError,
} from '../../redis/redis-backlog';

const PHONE = '+998901234567';
const OTHER = '+998907654321';
const COOLDOWN = RedisKeys.otpSendCooldown(otpCooldownPhone(PHONE));
const tick = () => new Promise((resolve) => setImmediate(resolve));

function build(devMode = false) {
  const store = new Map<string, unknown>();
  const ttls = new Map<string, number>();
  const redis = {
    store,
    ttls,
    get: jest.fn(async (k: string) => {
      await tick();
      return store.has(k) ? store.get(k) : null;
    }),
    setEx: jest.fn(async (k: string, t: number, v: unknown) => {
      await tick();
      store.set(k, JSON.parse(JSON.stringify(v)));
      ttls.set(k, t);
      return 'OK';
    }),
    setNxEx: jest.fn(async (k: string, t: number, claim: string) => {
      await tick();
      if (store.has(k)) return false;
      store.set(k, claim);
      ttls.set(k, t);
      return true;
    }),
    evalScript: jest.fn(async (_s: string, keys: string[], args: string[]) =>
      store.get(keys[0]) === args[0] ? (store.delete(keys[0]), 1) : 0,
    ),
    ttl: jest.fn(async (k: string) => ttls.get(k) ?? -2),
    expire: jest.fn(async () => true),
    incr: jest.fn(async (k: string) => {
      const next = ((store.get(k) as number) ?? 0) + 1;
      store.set(k, next);
      return next;
    }),
    del: jest.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
  };
  const queue = {
    enqueueOtpSms: jest.fn().mockResolvedValue({ id: 'j' }),
    otpSmsJobId: jest.fn((r: string, n: number) => `${r}_${n}`),
  };
  const service = new OtpService(
    redis as never,
    queue as never,
    { get: (k: string) => (k === 'AUTH_DEV_MODE' ? String(devMode) : undefined) } as never,
    new FixedWindowRateLimiter(redis as never),
  );
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn((service as any).logger, level).mockImplementation();
  }
  /** What Redis does by itself after 60 seconds. */
  const elapse = () => {
    for (const key of [...store.keys()]) {
      if (key.startsWith('otp:cooldown:')) store.delete(key);
    }
  };
  return { service, redis, queue, elapse };
}

const statusOf = (err: unknown) => (err as HttpException).getStatus();

describe('OTP send cooldown (SEC-006)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('accepts the first request, armed for exactly 60 seconds', async () => {
    const { service, redis, queue } = build();
    const issued = await service.request(PHONE);
    expect(queue.enqueueOtpSms).toHaveBeenCalledTimes(1);
    expect(issued.resendAfterSeconds).toBe(60);
    expect(redis.setNxEx).toHaveBeenCalledWith(COOLDOWN, 60, expect.any(String));
  });

  it('refuses an immediate second request with 429 and a retry-after value', async () => {
    const { service, redis, queue } = build();
    await service.request(PHONE);
    redis.ttls.set(COOLDOWN, 42);
    const err = await service.request(PHONE).catch((e: unknown) => e);
    expect(statusOf(err)).toBe(429);
    expect((err as HttpException).getResponse()).toMatchObject({
      code: 'OTP_COOLDOWN_ACTIVE',
      message: 'Please wait 42s before requesting a new code.',
      details: { retry_after_seconds: 42 },
    });
    expect(queue.enqueueOtpSms).toHaveBeenCalledTimes(1);
  });

  it('holds a resend to the same cooldown', async () => {
    const { service, queue } = build();
    const { requestId } = await service.request(PHONE);
    await expect(service.resend(requestId)).rejects.toMatchObject({ status: 429 });
    expect(queue.enqueueOtpSms).toHaveBeenCalledTimes(1);
  });

  it('accepts a request, and a resend, after 60 seconds', async () => {
    const { service, queue, elapse } = build();
    const { requestId } = await service.request(PHONE);
    elapse();
    await service.resend(requestId);
    elapse();
    await service.request(PHONE);
    expect(queue.enqueueOtpSms).toHaveBeenCalledTimes(3);
  });

  it('gives different numbers independent cooldowns', async () => {
    const { service, queue } = build();
    await service.request(PHONE);
    await service.request(OTHER);
    expect(queue.enqueueOtpSms).toHaveBeenCalledTimes(2);
  });

  it.each(['+998 90 123 45 67', '998901234567', '00998901234567', '+998(90)123-45-67'])(
    'treats %s as the same number',
    async (written) => {
      const { service, queue } = build();
      await service.request(PHONE);
      await expect(service.request(written)).rejects.toMatchObject({ status: 429 });
      expect(queue.enqueueOtpSms).toHaveBeenCalledTimes(1);
    },
  );

  it('shares one cooldown across every OTP purpose of a number', async () => {
    const { service, queue } = build();
    await service.request(PHONE);
    await expect(
      service.request(PHONE, undefined, OtpPurpose.PHONE_CHANGE_CURRENT),
    ).rejects.toMatchObject({ status: 429 });
    expect(queue.enqueueOtpSms).toHaveBeenCalledTimes(1);
  });

  it('lets exactly one of 50 concurrent requests through', async () => {
    const { service, queue } = build();
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => service.request(PHONE)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(queue.enqueueOtpSms).toHaveBeenCalledTimes(1);
  });

  it('lets exactly one of 20 concurrent resends through', async () => {
    const { service, queue, elapse } = build();
    const { requestId } = await service.request(PHONE);
    elapse();
    queue.enqueueOtpSms.mockClear();
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => service.resend(requestId)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(queue.enqueueOtpSms).toHaveBeenCalledTimes(1);
  });

  it('a refused request or resend leaves the live code usable', async () => {
    const { service, redis } = build(true);
    const issued = await service.request(PHONE);
    const before = JSON.stringify(redis.store.get(RedisKeys.otp(PHONE)));
    await service.request(PHONE).catch(() => undefined);
    await service.resend(issued.requestId).catch(() => undefined);
    expect(JSON.stringify(redis.store.get(RedisKeys.otp(PHONE)))).toBe(before);
    await expect(
      service.verify(issued.requestId, PHONE, issued.devOtpCode!),
    ).resolves.toBeUndefined();
  });

  describe('when the queue refuses the job', () => {
    it('answers 503, frees the cooldown and forgets the new code', async () => {
      const { service, redis, queue } = build();
      queue.enqueueOtpSms.mockRejectedValueOnce(new Error('queue down'));
      const err = await service.request(PHONE).catch((e: unknown) => e);
      expect(statusOf(err)).toBe(503);
      expect(redis.store.has(COOLDOWN)).toBe(false);
      expect(redis.store.has(RedisKeys.otp(PHONE))).toBe(false);
      await expect(service.request(PHONE)).resolves.toBeDefined();
    });

    it('puts the previous code back', async () => {
      const { service, redis, queue, elapse } = build();
      const first = await service.request(PHONE);
      const before = JSON.stringify(redis.store.get(RedisKeys.otp(PHONE)));
      elapse();
      queue.enqueueOtpSms.mockRejectedValueOnce(new Error('queue down'));
      await service.request(PHONE).catch(() => undefined);
      expect(JSON.stringify(redis.store.get(RedisKeys.otp(PHONE)))).toBe(before);
      expect(redis.store.get(RedisKeys.otpRequest(first.requestId))).toBe(PHONE);
    });

    it('a failed resend keeps the previous code and its send count', async () => {
      const { service, redis, queue, elapse } = build();
      const { requestId } = await service.request(PHONE);
      const before = JSON.stringify(redis.store.get(RedisKeys.otp(PHONE)));
      elapse();
      queue.enqueueOtpSms.mockRejectedValueOnce(new Error('queue down'));
      await expect(service.resend(requestId)).rejects.toMatchObject({ status: 503 });
      expect(JSON.stringify(redis.store.get(RedisKeys.otp(PHONE)))).toBe(before);
      expect(redis.store.has(COOLDOWN)).toBe(false);
    });

    it('cannot free a cooldown a newer request now holds', async () => {
      const { service, redis, queue } = build();
      queue.enqueueOtpSms.mockImplementationOnce(async () => {
        redis.store.set(COOLDOWN, 'newer-claim');
        throw new Error('queue down');
      });
      await service.request(PHONE).catch(() => undefined);
      expect(redis.store.get(COOLDOWN)).toBe('newer-claim');
    });

    it('a release that fails still ends with the 503, and the key has a TTL', async () => {
      const { service, redis, queue } = build();
      queue.enqueueOtpSms.mockRejectedValueOnce(new Error('queue down'));
      redis.evalScript.mockRejectedValueOnce(new RedisUnavailableError('down'));
      await expect(service.request(PHONE)).rejects.toMatchObject({ status: 503 });
      expect(redis.ttls.get(COOLDOWN)).toBe(60);
    });
  });

  it('keeps the code and cooldown when the queue only timed out (the job may land)', async () => {
    const { service, redis, queue } = build();
    queue.enqueueOtpSms.mockRejectedValueOnce(new RedisTimeoutError('OTP SMS enqueue', 3000));
    await expect(service.request(PHONE)).rejects.toMatchObject({ status: 503 });
    expect(redis.store.has(COOLDOWN)).toBe(true);
    expect(redis.store.has(RedisKeys.otp(PHONE))).toBe(true);
  });

  describe('when Redis fails', () => {
    it('issues nothing when the claim cannot be made', async () => {
      const { service, redis, queue } = build();
      redis.setNxEx.mockRejectedValueOnce(new RedisUnavailableError('down'));
      await expect(service.request(PHONE)).rejects.toBeInstanceOf(RedisUnavailableError);
      expect(queue.enqueueOtpSms).not.toHaveBeenCalled();
      expect(redis.store.has(RedisKeys.otp(PHONE))).toBe(false);
    });

    it('treats a missing answer as a refusal, never as a pass', async () => {
      const { service, redis, queue } = build();
      redis.setNxEx.mockResolvedValueOnce(undefined as never);
      await expect(service.request(PHONE)).rejects.toMatchObject({ status: 429 });
      expect(queue.enqueueOtpSms).not.toHaveBeenCalled();
    });

    it('works again once Redis is back', async () => {
      const { service, redis } = build();
      redis.setNxEx.mockRejectedValueOnce(new RedisUnavailableError('down'));
      await service.request(PHONE).catch(() => undefined);
      await expect(service.request(PHONE)).resolves.toBeDefined();
    });
  });

  it('leaves no sending counter and no budget key in Redis', async () => {
    const { service, redis } = build();
    await service.request(PHONE);
    expect(redis.incr).not.toHaveBeenCalled();
    expect([...redis.store.keys()].filter((k) => /budget|rate:otp:request/.test(k))).toEqual([]);
  });

  it('a duplicate delivery of one issue keeps the same job id', async () => {
    const { service, queue } = build();
    const { requestId } = await service.request(PHONE);
    expect(queue.enqueueOtpSms.mock.calls[0][1]).toEqual({ jobId: `${requestId}_0` });
  });
});
