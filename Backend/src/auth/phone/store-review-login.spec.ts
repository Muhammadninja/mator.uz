// Store-review sign-in: one configured number logs in with a fixed code and no
// SMS, so store reviewers without an Uzbek number can sign in repeatedly. Every
// other number, and every non-login purpose, must behave exactly as before.

import { OtpService, OtpPurpose } from './otp.service';
import { readStoreReviewLogin } from './store-review-login.config';
import { FixedWindowRateLimiter } from '../../redis/rate-limiter.service';

const REVIEW_PHONE = '+998900000777';
const REVIEW_CODE = '583041';
const CUSTOMER_PHONE = '+998901234567';

function makeRedisMock() {
  const store = new Map<string, unknown>();
  const ttls = new Map<string, number>();
  return {
    store,
    get: jest.fn(async (key: string) =>
      store.has(key) ? store.get(key) : null,
    ),
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
      store.set(key, JSON.parse(JSON.stringify(value)));
      ttls.set(key, ttl);
      return 'OK' as const;
    }),
    del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
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

function build(env: Record<string, string | undefined>) {
  const redis = makeRedisMock();
  const queue = {
    enqueueOtpSms: jest.fn().mockResolvedValue({ id: 'sms_job_1' }),
    otpSmsJobId: jest.fn((id: string, n: number) => `sms_otp_${id}_${n}`),
  };
  const config = { get: jest.fn((key: string) => env[key]) };
  const rateLimiter = new FixedWindowRateLimiter(redis as never);
  const service = new OtpService(
    redis as never,
    queue as never,
    config as never,
    rateLimiter,
  );
  return { service, queue };
}

const reviewEnv = {
  STORE_REVIEW_PHONE: REVIEW_PHONE,
  STORE_REVIEW_CODE: REVIEW_CODE,
};

describe('readStoreReviewLogin', () => {
  const read = (env: Record<string, string>) =>
    readStoreReviewLogin((k) => env[k]);

  it('is off when neither variable is set', () => {
    expect(read({})).toBeNull();
  });

  it('reads a valid number and code', () => {
    expect(read(reviewEnv)).toEqual({
      phoneE164: REVIEW_PHONE,
      code: REVIEW_CODE,
    });
  });

  it('refuses a half-set configuration', () => {
    expect(() => read({ STORE_REVIEW_PHONE: REVIEW_PHONE })).toThrow(
      /set together/,
    );
    expect(() => read({ STORE_REVIEW_CODE: REVIEW_CODE })).toThrow(
      /set together/,
    );
  });

  it('refuses a malformed number', () => {
    expect(() =>
      read({ ...reviewEnv, STORE_REVIEW_PHONE: '998900000777' }),
    ).toThrow(/\+998/);
  });

  it.each(['000000', '111111', '123456', '12345', 'abcdef'])(
    'refuses the code %s',
    (code) => {
      expect(() => read({ ...reviewEnv, STORE_REVIEW_CODE: code })).toThrow(
        /6 digits/,
      );
    },
  );
});

describe('OtpService — store-review sign-in', () => {
  it('signs the review number in with the fixed code and sends no SMS', async () => {
    const { service, queue } = build(reviewEnv);

    const issued = await service.request(REVIEW_PHONE);

    expect(queue.enqueueOtpSms).not.toHaveBeenCalled();
    expect(issued.devOtpCode).toBeUndefined();
    await expect(
      service.verify(
        issued.requestId,
        REVIEW_PHONE,
        REVIEW_CODE,
        OtpPurpose.LOGIN,
      ),
    ).resolves.not.toThrow();
  });

  // More sign-ins than the 5-per-hour send quota allows; still under the
  // 10-per-hour verification ceiling, which stays on to stop guessing the code.
  it('can sign in again and again, with no cooldown or send quota', async () => {
    const { service } = build(reviewEnv);

    for (let i = 0; i < 8; i += 1) {
      const issued = await service.request(REVIEW_PHONE);
      await service.verify(
        issued.requestId,
        REVIEW_PHONE,
        REVIEW_CODE,
        OtpPurpose.LOGIN,
      );
    }
  });

  it('rejects a wrong code for the review number', async () => {
    const { service } = build(reviewEnv);

    const issued = await service.request(REVIEW_PHONE);

    await expect(
      service.verify(
        issued.requestId,
        REVIEW_PHONE,
        '000001',
        OtpPurpose.LOGIN,
      ),
    ).rejects.toThrow();
  });

  it('keeps the fixed code on resend', async () => {
    const { service, queue } = build(reviewEnv);

    const issued = await service.request(REVIEW_PHONE);
    const resent = await service.resend(issued.requestId);

    expect(queue.enqueueOtpSms).not.toHaveBeenCalled();
    await expect(
      service.verify(
        resent.requestId,
        REVIEW_PHONE,
        REVIEW_CODE,
        OtpPurpose.LOGIN,
      ),
    ).resolves.not.toThrow();
  });

  it('leaves every other number on the normal SMS login', async () => {
    const { service, queue } = build(reviewEnv);

    const issued = await service.request(CUSTOMER_PHONE);

    expect(queue.enqueueOtpSms).toHaveBeenCalledTimes(1);
    const sent = queue.enqueueOtpSms.mock.calls[0][0].otp.code;
    expect(sent).toMatch(/^\d{6}$/);
    await expect(
      service.verify(
        issued.requestId,
        CUSTOMER_PHONE,
        REVIEW_CODE,
        OtpPurpose.LOGIN,
      ),
    ).rejects.toThrow();
    // The cooldown still applies to a real number.
    await expect(service.request(CUSTOMER_PHONE)).rejects.toThrow();
  });

  it('does not apply to a phone change involving the review number', async () => {
    const { service, queue } = build(reviewEnv);

    const issued = await service.request(
      REVIEW_PHONE,
      undefined,
      OtpPurpose.PHONE_CHANGE,
    );

    expect(queue.enqueueOtpSms).toHaveBeenCalledTimes(1);
    await expect(
      service.verify(
        issued.requestId,
        REVIEW_PHONE,
        REVIEW_CODE,
        OtpPurpose.PHONE_CHANGE,
      ),
    ).rejects.toThrow();
  });

  it('is entirely off without the variables', async () => {
    const { service, queue } = build({});

    await service.request(REVIEW_PHONE);

    expect(queue.enqueueOtpSms).toHaveBeenCalledTimes(1);
  });
});
