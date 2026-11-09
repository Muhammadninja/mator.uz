// SEC-008: the real OtpService and PhoneChangeService over an in-memory Redis, so
// expiry, single use and purpose isolation are the production rules.
import { OtpService, OtpPurpose } from '../auth/phone/otp.service';
import { RedisKeys } from '../redis/redis.keys';
import { buildAppUser, fakeRedis } from '../../test/utils/harness';
import { PhoneChangeService } from './phone-change.service';

const OLD = '+998900000000';
const NEW = '+998901234567';
const OTHER = '+998907777777';

function world(account: { phoneE164: string | null } = { phoneE164: OLD }) {
  const redis = fakeRedis();
  // FixedWindowRateLimiter's contract, always allowing: limits have their own spec.
  const limiter = {
    consume: jest.fn().mockResolvedValue({ allowed: true }),
    check: jest.fn().mockResolvedValue({ remaining: 5 }),
  };
  const otp = new OtpService(
    redis,
    { enqueueOtpSms: jest.fn(), otpSmsJobId: jest.fn() } as never,
    {
      get: (k: string) => (k === 'AUTH_DEV_MODE' ? 'true' : undefined),
    } as never,
    limiter as never,
  );
  jest.spyOn((otp as any).logger, 'warn').mockImplementation();
  jest.spyOn((otp as any).logger, 'log').mockImplementation();
  const row = buildAppUser({ id: 'u1', ...account });
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    appUser: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.phoneE164 ? null : { ...row },
      ),
      update: jest.fn(async ({ data }: any) => {
        Object.assign(row, data);
        return { ...row };
      }),
    },
  };
  const prisma = {
    appUser: tx.appUser,
    $transaction: jest.fn((cb: any) => cb(tx)),
  };
  const tokens = {
    revokeAllSessions: jest.fn().mockResolvedValue(1),
    notifySessionsRevoked: jest.fn(),
    issueSession: jest.fn().mockResolvedValue({
      accessToken: 'a',
      accessTokenExpiresAt: new Date(),
      refreshToken: 'r',
      refreshTokenExpiresAt: new Date(),
      tokenType: 'Bearer',
    }),
  };
  const queue = { enqueueSms: jest.fn().mockResolvedValue({}) };
  const service = new PhoneChangeService(
    prisma as never,
    otp,
    tokens as never,
    redis,
    queue as never,
  );
  return { service, otp, redis, row, tokens, queue, tx };
}

const pair = (res: Record<string, any>) => ({
  fresh: res.dev_otp_code as string,
  current: res.dev_current_phone_otp_code as string,
});

/** What Redis does by itself after 60 seconds. */
function elapseCooldowns(redis: { store: Map<string, unknown> }) {
  for (const key of [...redis.store.keys()]) {
    if (key.startsWith('otp:cooldown:')) redis.store.delete(key);
  }
}

describe('Phone change needs both numbers (SEC-008)', () => {
  it('sends a code to the number on the account, not one the client names', async () => {
    const { service, redis } = world();
    const res = await service.request('u1', NEW);
    expect(res.current_phone_otp_required).toBe(true);
    expect(redis.store.has(RedisKeys.otp(`phone_change_current:${OLD}`))).toBe(
      true,
    );
  });

  it('refuses a confirmation with only the new number’s code', async () => {
    const { service, row, tokens } = world();
    const { fresh } = pair(await service.request('u1', NEW));
    await expect(service.confirm('u1', NEW, fresh)).rejects.toMatchObject({
      response: { code: 'CURRENT_PHONE_PROOF_REQUIRED' },
      status: 403,
    });
    expect(row.phoneE164).toBe(OLD);
    expect(tokens.revokeAllSessions).not.toHaveBeenCalled();
  });

  it('accepts both proofs, revokes the sessions and tells the previous number', async () => {
    const { service, row, tokens, queue } = world();
    const { fresh, current } = pair(await service.request('u1', NEW));
    await expect(
      service.confirm('u1', NEW, fresh, current),
    ).resolves.toBeDefined();
    expect(row.phoneE164).toBe(NEW);
    expect(tokens.revokeAllSessions).toHaveBeenCalledTimes(1);
    expect(queue.enqueueSms).toHaveBeenCalledWith(
      expect.objectContaining({ phone: OLD, template: 'phone_changed' }),
    );
  });

  it('still completes when the notice cannot be queued', async () => {
    const { service, row, queue } = world();
    queue.enqueueSms.mockRejectedValue(new Error('redis down'));
    jest.spyOn((service as any).logger, 'error').mockImplementation();
    const { fresh, current } = pair(await service.request('u1', NEW));
    await service.confirm('u1', NEW, fresh, current);
    expect(row.phoneE164).toBe(NEW);
  });

  it('rejects an expired operation', async () => {
    const { service, redis } = world();
    const { fresh, current } = pair(await service.request('u1', NEW));
    const key = RedisKeys.phoneChange('u1');
    redis.store.set(key, { ...(redis.store.get(key) as object), expiresAt: 1 });
    await expect(
      service.confirm('u1', NEW, fresh, current),
    ).rejects.toMatchObject({
      status: 410,
    });
  });

  it('rejects codes reused after a successful change', async () => {
    const { service, row } = world();
    const { fresh, current } = pair(await service.request('u1', NEW));
    await service.confirm('u1', NEW, fresh, current);
    row.phoneE164 = OLD;
    await expect(
      service.confirm('u1', NEW, fresh, current),
    ).rejects.toMatchObject({
      response: { code: 'PHONE_CHANGE_NOT_REQUESTED' },
    });
  });

  it('rejects a code proving a different phone', async () => {
    const { service } = world();
    const { fresh, current } = pair(await service.request('u1', NEW));
    await expect(
      service.confirm('u1', OTHER, fresh, current),
    ).rejects.toMatchObject({
      response: { code: 'PHONE_CHANGE_NOT_REQUESTED' },
    });
  });

  it('keeps both codes usable after one was mistyped', async () => {
    const { service, row } = world();
    const { fresh, current } = pair(await service.request('u1', NEW));
    await expect(
      service.confirm('u1', NEW, fresh, '000000'),
    ).rejects.toMatchObject({
      status: 401,
    });
    await service.confirm('u1', NEW, fresh, current);
    expect(row.phoneE164).toBe(NEW);
  });

  it('a later request replaces the pending codes', async () => {
    const { service, redis } = world();
    const first = pair(await service.request('u1', NEW));
    elapseCooldowns(redis);
    await service.request('u1', OTHER);
    await expect(
      service.confirm('u1', NEW, first.fresh, first.current),
    ).rejects.toMatchObject({
      response: { code: 'PHONE_CHANGE_NOT_REQUESTED' },
    });
  });

  it('two concurrent confirmations cannot both succeed', async () => {
    const { service, tokens } = world();
    const { fresh, current } = pair(await service.request('u1', NEW));
    const results = await Promise.allSettled([
      service.confirm('u1', NEW, fresh, current),
      service.confirm('u1', NEW, fresh, current),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(tokens.revokeAllSessions).toHaveBeenCalledTimes(1);
  });

  it('does not make an account without a number prove one', async () => {
    const { service, row } = world({ phoneE164: null });
    const res = await service.request('u1', NEW);
    expect(res.current_phone_otp_required).toBe(false);
    await service.confirm('u1', NEW, res.dev_otp_code!);
    expect(row.phoneE164).toBe(NEW);
  });

  it('leaves a login code on the same number intact', async () => {
    const { service, otp, redis } = world();
    const login = await otp.request(OLD);
    elapseCooldowns(redis);
    await service.request('u1', NEW);
    expect(redis.store.has(RedisKeys.otp(OLD))).toBe(true);
    await expect(
      otp.verify(login.requestId, OLD, login.devOtpCode!, OtpPurpose.LOGIN),
    ).resolves.toBeUndefined();
  });

  it('waits out the same minute as a login code to that number', async () => {
    const { service, otp } = world();
    await otp.request(OLD);
    await expect(service.request('u1', NEW)).rejects.toMatchObject({ status: 429 });
  });

  it('a phone-change code cannot sign in', async () => {
    const { service, otp, redis } = world();
    const { current } = pair(await service.request('u1', NEW));
    const pending = redis.store.get(RedisKeys.phoneChange('u1')) as {
      currentRequestId: string;
    };
    await expect(
      otp.verify(pending.currentRequestId, OLD, current, OtpPurpose.LOGIN),
    ).rejects.toMatchObject({ status: 400 });
  });
});
