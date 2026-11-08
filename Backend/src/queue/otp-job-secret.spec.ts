// SEC-005: an OTP job carries a reference, never the code.
import { UnrecoverableError } from 'bullmq';
import { collectAuthEnvErrors } from '../auth/auth-env.config';
import { fakeRedis } from '../../test/utils/harness';
import { OtpJobSecretStore, parseOtpJobKey } from './otp-job-secret.store';
import { SmsProcessor } from './queue.processors';
import { QueueService, type SmsOtpJobData } from './queue.service';

const KEY = 'a'.repeat(64);
const PHONE = '+998901234567';
const CODE = '731904';

function world(key: string | undefined = KEY) {
  const redis = fakeRedis();
  const secrets = new OtpJobSecretStore(redis, {
    get: () => key,
  } as never);
  const smsQueue = { add: jest.fn().mockResolvedValue({ id: 'j' }) };
  const queue = new QueueService(
    {} as never,
    smsQueue as never,
    {} as never,
    secrets,
  );
  const sms = { sendOtp: jest.fn().mockResolvedValue(undefined) };
  const processor = new SmsProcessor(sms as never, secrets);
  jest.spyOn((processor as any).logger, 'log').mockImplementation();
  jest.spyOn((processor as any).logger, 'warn').mockImplementation();
  const enqueue = (expiresAt = Date.now() + 300_000) =>
    queue.enqueueOtpSms(
      { phone: PHONE, otp: { code: CODE, lang: 'ru', expiresAt } },
      { jobId: 'sms_otp_r1_0' },
    );
  const job = () =>
    ({ id: 'j', data: smsQueue.add.mock.calls[0][1] }) as {
      id: string;
      data: SmsOtpJobData;
    };
  return { redis, secrets, smsQueue, sms, processor, enqueue, job };
}

describe('OTP job secrecy', () => {
  it('puts no code in the job, and removes the job once it completes', async () => {
    const { smsQueue, enqueue } = world();
    await enqueue();
    const [, data, opts] = smsQueue.add.mock.calls[0];
    expect(JSON.stringify(data)).not.toContain(CODE);
    expect(data).toEqual({
      phone: PHONE,
      otp: { ref: 'sms_otp_r1_0', lang: 'ru' },
    });
    expect(opts.removeOnComplete).toBe(true);
  });

  it('stores the code encrypted, for only as long as it is valid', async () => {
    const { redis, enqueue } = world();
    await enqueue(Date.now() + 120_000);
    const stored = JSON.stringify([...redis.store.values()]);
    expect(stored).not.toContain(CODE);
    expect([...redis.ttls.values()][0]).toBeLessThanOrEqual(120);
  });

  it('lets the worker resolve the code within its lifetime and then drops it', async () => {
    const { redis, sms, processor, enqueue, job } = world();
    await enqueue();
    await processor.process(job() as never);
    expect(sms.sendOtp).toHaveBeenCalledWith(PHONE, CODE, 'ru');
    expect(redis.store.size).toBe(0);
  });

  it('retries a failed send with the same code while it is valid', async () => {
    const { sms, processor, enqueue, job } = world();
    await enqueue();
    sms.sendOtp.mockRejectedValueOnce(new Error('provider down'));
    await expect(processor.process(job() as never)).rejects.toThrow(
      'provider down',
    );
    await processor.process(job() as never);
    expect(sms.sendOtp).toHaveBeenCalledTimes(2);
    expect(sms.sendOtp).toHaveBeenLastCalledWith(PHONE, CODE, 'ru');
  });

  it('does not send a code that has expired', async () => {
    const { sms, processor, enqueue, job } = world();
    jest.useFakeTimers({ now: Date.now() });
    try {
      await enqueue(Date.now() + 1_000);
      jest.advanceTimersByTime(2_000);
      await processor.process(job() as never);
    } finally {
      jest.useRealTimers();
    }
    expect(sms.sendOtp).not.toHaveBeenCalled();
  });

  it('leaves a failed job nothing to recover once the entry lapses', async () => {
    const { redis, sms, processor, enqueue, job } = world();
    await enqueue();
    redis.store.clear(); // what the Redis TTL does
    await processor.process(job() as never);
    expect(sms.sendOtp).not.toHaveBeenCalled();
    expect(JSON.stringify(job().data)).not.toContain(CODE);
  });

  it('binds the ciphertext to its job: another phone cannot open it', async () => {
    const { secrets, enqueue } = world();
    await enqueue();
    await expect(secrets.open('sms_otp_r1_0', '+998900000000')).rejects.toThrow(
      'could not be decrypted',
    );
  });

  it('never retries an entry that cannot be decrypted', async () => {
    const { redis, processor, enqueue, job } = world();
    await enqueue();
    const [key] = [...redis.store.keys()];
    redis.store.set(key, 'garbage.garbage.garbage');
    await expect(processor.process(job() as never)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it('never falls back to plaintext without a key: no job is queued', async () => {
    const { smsQueue, enqueue } = world('');
    await expect(enqueue()).rejects.toThrow('OTP_JOB_ENCRYPTION_KEY');
    expect(smsQueue.add).not.toHaveBeenCalled();
  });

  it('drops a job from before references existed rather than read its code', async () => {
    const { sms, processor } = world();
    await processor.process({
      id: 'old',
      data: { phone: PHONE, otp: { code: CODE, lang: 'ru' } },
    } as never);
    expect(sms.sendOtp).not.toHaveBeenCalled();
  });

  it('refuses to boot in production without a valid key', () => {
    expect(parseOtpJobKey('short')).toBeNull();
    expect(parseOtpJobKey(KEY)).toHaveLength(32);
    expect(collectAuthEnvErrors({ NODE_ENV: 'production' }).join()).toContain(
      'OTP_JOB_ENCRYPTION_KEY',
    );
    expect(
      collectAuthEnvErrors({
        NODE_ENV: 'production',
        OTP_JOB_ENCRYPTION_KEY: KEY,
      }),
    ).toEqual([]);
  });
});
