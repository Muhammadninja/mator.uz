/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Staging tester OTP. Codes are issued, resent, verified and rate-limited by the
 * ordinary OtpService; only who may ask, and where the code goes, differ. Covers:
 * unauthorized numbers, wrong or forged tester identity, expiry, revocation,
 * resend abuse, the inbox's isolation, no plaintext anywhere, and the refusal to
 * run in production.
 */
import { Logger } from '@nestjs/common';
import { OtpService, OtpPurpose, otpCooldownPhone } from './otp.service';
import { StagingOtpPolicy } from './staging-otp.policy';
import {
  collectStagingOtpEnvErrors,
  parseStagingTesters,
  readStagingOtpConfig,
} from './staging-otp.config';
import { validateAuthEnv } from '../auth-env.config';
import { StagingOtpController } from './staging-otp.controller';
import { OtpJobSecretStore } from '../../queue/otp-job-secret.store';
import { FixedWindowRateLimiter } from '../../redis/rate-limiter.service';
import { RedisKeys } from '../../redis/redis.keys';
import { requestContext } from '../../common/request-context';
import { requestIdMiddleware } from '../../common/request-id.middleware';

const ALICE = '+998901110001';
const ALICE_2 = '+998901110002';
const BOB = '+998902220001';
const STRANGER = '+998903330001';
const SECRET = 'p'.repeat(48);
const KEY = 'ab'.repeat(32);
const TESTERS = `alice=${ALICE}|${ALICE_2},bob=${BOB}`;

const STAGING_ENV = {
  NODE_ENV: 'staging',
  STAGING_OTP_ENABLED: 'true',
  STAGING_OTP_TESTERS: TESTERS,
  STAGING_PROXY_SECRET: SECRET,
  OTP_JOB_ENCRYPTION_KEY: KEY,
  AUTH_DEV_MODE: 'false',
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/mator_staging',
};

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
type Redis = ReturnType<typeof makeRedisMock>;

function makeQueue() {
  return {
    enqueueOtpSms: jest.fn().mockResolvedValue({ id: 'job' }),
    otpSmsJobId: jest.fn((id: string, n: number) => `sms_otp_${id}_${n}`),
  };
}

const configOf = (env: Record<string, string | undefined>) =>
  ({ get: (key: string) => env[key] }) as any;

function build(
  env: Record<string, string | undefined> = STAGING_ENV,
  redis: Redis = makeRedisMock(),
) {
  const queue = makeQueue();
  const config = configOf(env);
  const service = new OtpService(
    redis as never,
    queue as never,
    config,
    new FixedWindowRateLimiter(redis as never),
    new StagingOtpPolicy(config),
    new OtpJobSecretStore(redis as never, config),
  );
  return { service, redis, queue };
}

/** As the staging proxy would forward it; `auth: null` sends no proxy secret. */
const as = <T>(
  tester: string | undefined,
  fn: () => Promise<T>,
  auth: string | null = SECRET,
) =>
  requestContext.run(
    { requestId: 'T', stagingProxy: { tester, auth: auth ?? undefined } },
    fn,
  );

const inboxOf = async (service: OtpService, tester: string) =>
  as(tester, () => new StagingOtpController(service).inbox());

const codeFor = async (
  service: OtpService,
  tester: string,
  requestId: string,
) => {
  const { items } = await inboxOf(service, tester);
  return items.find((i) => i.request_id === requestId)?.code;
};

const elapseCooldown = (redis: Redis, phone: string) =>
  redis.store.delete(RedisKeys.otpSendCooldown(otpCooldownPhone(phone)));

/** Nothing about this number was claimed, generated, stored or queued. */
function expectUntouched(
  redis: Redis,
  queue: ReturnType<typeof makeQueue>,
  phone: string,
) {
  expect(
    [...redis.store.keys()].filter(
      (k) => k.includes(phone) || k.includes(otpCooldownPhone(phone)),
    ),
  ).toEqual([]);
  expect(queue.enqueueOtpSms).not.toHaveBeenCalled();
}

describe('configuration and production refusal', () => {
  it('is valid when complete on staging', () => {
    expect(collectStagingOtpEnvErrors(STAGING_ENV)).toEqual([]);
    expect(readStagingOtpConfig((k) => (STAGING_ENV as any)[k]).enabled).toBe(
      true,
    );
  });

  it.each(['true', 'TRUE', ' true '])(
    'production refuses to boot with STAGING_OTP_ENABLED=%j',
    (value) => {
      const env = {
        ...STAGING_ENV,
        NODE_ENV: 'production',
        STAGING_OTP_ENABLED: value,
      };
      expect(collectStagingOtpEnvErrors(env)).toEqual([
        expect.stringContaining('forbidden in production'),
      ]);
      expect(() => validateAuthEnv(env)).toThrow(/forbidden in production/);
    },
  );

  it('production without the switch is unaffected', () => {
    expect(collectStagingOtpEnvErrors({ NODE_ENV: 'production' })).toEqual([]);
  });

  it('the service itself refuses production even without the boot check', () => {
    expect(
      () =>
        new StagingOtpPolicy(
          configOf({ ...STAGING_ENV, NODE_ENV: 'production' }),
        ),
    ).toThrow(/forbidden in production/);
  });

  it.each([
    ['development', { NODE_ENV: 'development' }, /requires NODE_ENV=staging/],
    ['dev OTP', { AUTH_DEV_MODE: 'true' }, /AUTH_DEV_MODE/],
    ['short proxy secret', { STAGING_PROXY_SECRET: 'short' }, /at least 32/],
    ['no testers', { STAGING_OTP_TESTERS: '' }, /at least one tester/],
    [
      'non-E.164 number',
      { STAGING_OTP_TESTERS: 'alice=998901110001' },
      /not E.164/,
    ],
    [
      'number on two testers',
      { STAGING_OTP_TESTERS: `alice=${ALICE},bob=${ALICE}` },
      /more than one tester/,
    ],
    [
      'no encryption key',
      { OTP_JOB_ENCRYPTION_KEY: undefined },
      /OTP_JOB_ENCRYPTION_KEY/,
    ],
    [
      'production database',
      { DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/mator' },
      /production database/,
    ],
  ])('refuses %s', (_label, patch, message) => {
    const env = { ...STAGING_ENV, ...patch };
    expect(collectStagingOtpEnvErrors(env).join('\n')).toMatch(message);
    // Anything incomplete reads as off at runtime, granting nobody.
    if (!('DATABASE_URL' in patch) && !('OTP_JOB_ENCRYPTION_KEY' in patch)) {
      expect(readStagingOtpConfig((k) => (env as any)[k]).enabled).toBe(false);
    }
  });

  it('parses several numbers per tester', () => {
    expect(parseStagingTesters(TESTERS).testers.get('alice')?.phones).toEqual([
      ALICE,
      ALICE_2,
    ]);
  });
});

describe('who may ask for a code', () => {
  it('rejects a number no tester holds before claiming, generating or queuing anything', async () => {
    const { service, redis, queue } = build();
    await expect(
      as('alice', () => service.request(STRANGER)),
    ).rejects.toMatchObject({ status: 403 });
    expectUntouched(redis, queue, STRANGER);
  });

  it("rejects another tester's number", async () => {
    const { service, redis, queue } = build();
    await expect(as('bob', () => service.request(ALICE))).rejects.toMatchObject(
      { status: 403 },
    );
    expectUntouched(redis, queue, ALICE);
  });

  it.each([
    ['no proxy headers at all', undefined, null],
    ['a tester header without the proxy secret', 'alice', null],
    ['a forged proxy secret', 'alice', 'x'.repeat(48)],
    ['an unknown tester with the right secret', 'mallory', SECRET],
  ])('trusts no identity from %s', async (_label, tester, auth) => {
    const { service, redis, queue } = build();
    await expect(
      as(tester, () => service.request(ALICE), auth),
    ).rejects.toMatchObject({ status: 403 });
    expectUntouched(redis, queue, ALICE);
  });

  it('outside any HTTP request (workers, cron) nobody qualifies', async () => {
    const { service } = build();
    await expect(service.request(ALICE)).rejects.toMatchObject({ status: 403 });
  });
});

describe('delivery to the tester', () => {
  it('sends no SMS, returns no code, and lets only the owner read it', async () => {
    const { service, redis, queue } = build();
    const issued = await as('alice', () => service.request(ALICE));

    expect(queue.enqueueOtpSms).not.toHaveBeenCalled();
    expect(issued.devOtpCode).toBeUndefined();
    expect(JSON.stringify(issued)).not.toMatch(/"code"/);

    const code = await codeFor(service, 'alice', issued.requestId);
    expect(code).toMatch(/^\d{6}$/);
    expect((await inboxOf(service, 'bob')).items).toEqual([]);
    // Never stored in the clear: only the record's hash and the sealed copy exist.
    expect(JSON.stringify([...redis.store.values()])).not.toContain(
      `"${code}"`,
    );

    await as('alice', () => service.verify(issued.requestId, ALICE, code!));
    expect((await inboxOf(service, 'alice')).items).toEqual([]);
  });

  it('never writes the code to a log line', async () => {
    const lines: string[] = [];
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
      (m) =>
        jest
          .spyOn(Logger.prototype, m)
          .mockImplementation((...args: unknown[]) => {
            lines.push(args.map(String).join(' '));
          }),
    );
    try {
      const { service } = build();
      const issued = await as('alice', () => service.request(ALICE));
      const code = await codeFor(service, 'alice', issued.requestId);
      await as('alice', () => service.verify(issued.requestId, ALICE, code!));
      expect(lines.join('\n')).not.toContain(code!);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it('the inbox is 404 for a non-tester, a forged secret, or with staging OTP off', async () => {
    const { service } = build();
    await expect(
      as(undefined, () => new StagingOtpController(service).inbox()),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      as(
        'alice',
        () => new StagingOtpController(service).inbox(),
        'y'.repeat(48),
      ),
    ).rejects.toMatchObject({ status: 404 });
    const off = build({ ...STAGING_ENV, STAGING_OTP_ENABLED: 'false' }).service;
    await expect(
      as('alice', () => new StagingOtpController(off).inbox()),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('verification', () => {
  it("another tester cannot redeem the owner's code, nor spend the owner's attempts", async () => {
    const { service } = build();
    const issued = await as('alice', () => service.request(ALICE));
    const code = await codeFor(service, 'alice', issued.requestId);

    for (let i = 0; i < 6; i++) {
      await expect(
        as('bob', () => service.verify(issued.requestId, ALICE, code!)),
      ).rejects.toMatchObject({ status: 403 });
    }
    await expect(
      as('alice', () => service.verify(issued.requestId, ALICE, code!)),
    ).resolves.toBeUndefined();
  });

  it('an expired code is refused and leaves the inbox', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-13T10:00:00Z') });
    try {
      const { service } = build();
      const issued = await as('alice', () => service.request(ALICE));
      const code = await codeFor(service, 'alice', issued.requestId);
      jest.setSystemTime(new Date('2026-11-13T10:05:01Z'));

      await expect(
        as('alice', () => service.verify(issued.requestId, ALICE, code!)),
      ).rejects.toMatchObject({ status: 410 });
      expect((await inboxOf(service, 'alice')).items).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a tester removed from the list can no longer verify, resend or read a code issued before', async () => {
    const redis = makeRedisMock();
    const before = build(STAGING_ENV, redis).service;
    const issued = await as('alice', () => before.request(ALICE));
    const code = await codeFor(before, 'alice', issued.requestId);

    const after = build(
      { ...STAGING_ENV, STAGING_OTP_TESTERS: `bob=${BOB}` },
      redis,
    ).service;
    elapseCooldown(redis, ALICE);
    await expect(
      as('alice', () => after.verify(issued.requestId, ALICE, code!)),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      as('alice', () => after.resend(issued.requestId)),
    ).rejects.toMatchObject({ status: 403 });
    await expect(inboxOf(after, 'alice')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('phone-change purposes are bound the same way', async () => {
    const { service } = build();
    await expect(
      as('bob', () =>
        service.request(ALICE_2, undefined, OtpPurpose.PHONE_CHANGE),
      ),
    ).rejects.toMatchObject({ status: 403 });
    const issued = await as('alice', () =>
      service.request(ALICE_2, undefined, OtpPurpose.PHONE_CHANGE),
    );
    const { items } = await inboxOf(service, 'alice');
    expect(items).toEqual([
      expect.objectContaining({
        request_id: issued.requestId,
        purpose: 'phone_change',
        phone: ALICE_2,
      }),
    ]);
  });
});

describe('resend abuse uses the ordinary limits', () => {
  it('a second request or resend inside the cooldown is refused, and a later resend replaces the code', async () => {
    const { service, redis } = build();
    const issued = await as('alice', () => service.request(ALICE));
    const first = await codeFor(service, 'alice', issued.requestId);

    await expect(
      as('alice', () => service.request(ALICE)),
    ).rejects.toMatchObject({ status: 429 });
    await expect(
      as('alice', () => service.resend(issued.requestId)),
    ).rejects.toMatchObject({ status: 429 });
    await expect(
      as('bob', () => service.resend(issued.requestId)),
    ).rejects.toMatchObject({ status: 403 });

    elapseCooldown(redis, ALICE);
    await as('alice', () => service.resend(issued.requestId));
    const { items } = await inboxOf(service, 'alice');
    expect(items).toHaveLength(1);
    const second = items[0].code;
    if (second !== first) {
      await expect(
        as('alice', () => service.verify(issued.requestId, ALICE, first!)),
      ).rejects.toMatchObject({ status: 401 });
    }
    await expect(
      as('alice', () => service.verify(issued.requestId, ALICE, second)),
    ).resolves.toBeUndefined();
  });

  it('wrong guesses still hit the per-request ceiling', async () => {
    const { service } = build();
    const issued = await as('alice', () => service.request(ALICE));
    const code = await codeFor(service, 'alice', issued.requestId);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      await expect(
        as('alice', () => service.verify(issued.requestId, ALICE, wrong)),
      ).rejects.toMatchObject({ status: 401 });
    }
    await expect(
      as('alice', () => service.verify(issued.requestId, ALICE, code!)),
    ).rejects.toMatchObject({ status: 429 });
  });
});

describe('with staging OTP off, nothing changes', () => {
  it('any number gets an SMS through the queue, with no tester involved', async () => {
    const { service, queue } = build({
      NODE_ENV: 'production',
      OTP_JOB_ENCRYPTION_KEY: KEY,
    });
    await service.request(STRANGER);
    expect(queue.enqueueOtpSms).toHaveBeenCalledTimes(1);
  });
});

describe('request context capture', () => {
  const run = (headers: Record<string, unknown>) => {
    let seen: unknown;
    requestIdMiddleware(
      { headers } as any,
      { setHeader: jest.fn() } as any,
      () => {
        seen = requestContext.getStore()?.stagingProxy;
      },
    );
    return seen;
  };

  it('records the proxy headers unverified, and nothing when absent', () => {
    expect(
      run({
        'x-mator-staging-tester': 'alice',
        'x-mator-staging-proxy-auth': SECRET,
      }),
    ).toEqual({ tester: 'alice', auth: SECRET });
    expect(run({})).toBeUndefined();
  });

  it('drops oversized or repeated values', () => {
    expect(run({ 'x-mator-staging-tester': 'a'.repeat(65) })).toBeUndefined();
    expect(run({ 'x-mator-staging-tester': ['alice', 'bob'] })).toBeUndefined();
  });
});
