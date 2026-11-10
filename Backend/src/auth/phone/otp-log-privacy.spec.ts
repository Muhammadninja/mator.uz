// LOW-PLT-012: what the OTP and SMS paths write to the log. Every Logger method
// is captured, across request, enqueue, a failed SMS job, and a successful and a
// failed verification. No line may carry the full phone number or the code.

import { Logger } from '@nestjs/common';
import { OtpChannel } from '@prisma/client';
import { OtpService } from './otp.service';
import { FixedWindowRateLimiter } from '../../redis/rate-limiter.service';
import { QueueService } from '../../queue/queue.service';
import { SmsProcessor } from '../../queue/queue.processors';
import { EskizSmsProvider } from '../../sms/providers/eskiz.provider';

const PHONE = '+998901234567';
const MASKED = '+998*******67';

function memoryRedis() {
  const store = new Map<string, unknown>();
  return {
    get: async (k: string) => (store.has(k) ? store.get(k) : null),
    setNxEx: async (k: string, _t: number, v: string) =>
      store.has(k) ? false : (store.set(k, v), true),
    setEx: async (k: string, _t: number, v: unknown) => (
      store.set(k, JSON.parse(JSON.stringify(v))),
      'OK'
    ),
    del: async (k: string) => (store.delete(k) ? 1 : 0),
    incr: async (k: string) => {
      const n = ((store.get(k) as number) ?? 0) + 1;
      store.set(k, n);
      return n;
    },
    expire: async () => true,
    ttl: async () => 60,
    evalScript: async () => 1,
  };
}

describe('OTP / SMS log privacy', () => {
  const lines: string[] = [];
  const spies: jest.SpyInstance[] = [];

  beforeAll(() => {
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      spies.push(
        jest
          .spyOn(Logger.prototype, level)
          .mockImplementation((...args: unknown[]) => {
            lines.push(args.map(String).join(' '));
          }),
      );
    }
  });
  afterAll(() => spies.forEach((s) => s.mockRestore()));
  beforeEach(() => (lines.length = 0));

  function assertClean(code?: string) {
    const all = lines.join('\n');
    expect(all).not.toContain(PHONE);
    expect(all).not.toContain('901234567');
    if (code) expect(all).not.toContain(code);
  }

  function otpService(devMode: boolean, queue: unknown) {
    const redis = memoryRedis();
    return new OtpService(
      redis as never,
      queue as never,
      {
        get: (k: string) =>
          k === 'AUTH_DEV_MODE' ? String(devMode) : undefined,
      } as never,
      new FixedWindowRateLimiter(redis as never),
    );
  }

  it('OTP request and SMS enqueue log a masked number, a request id and a job id, never the code', async () => {
    let queuedCode = '';
    const add = jest.fn().mockResolvedValue({ id: 'job_1' });
    const queue = new QueueService(
      {} as never,
      { add } as never,
      {} as never,
      {
        seal: jest.fn(async (otp: { code: string }) => {
          queuedCode = otp.code;
          return 'ref_1';
        }),
      } as never,
    );
    const service = otpService(false, queue);

    const issued = await service.request(PHONE, OtpChannel.SMS);
    await queue.enqueueSms({ phone: PHONE, message: 'notice' });

    expect(lines.join('\n')).toContain(MASKED);
    expect(lines.join('\n')).toContain(issued.requestId);
    assertClean(queuedCode || undefined);
    // The job handed to the queue does not carry the code either.
    expect(JSON.stringify(add.mock.calls)).not.toContain(
      queuedCode || 'x'.repeat(40),
    );
  });

  it('successful and failed verification log neither the number nor the code', async () => {
    const service = otpService(true, {});
    const issued = await service.request(PHONE, OtpChannel.SMS);
    const code = issued.devOtpCode!;
    const wrong = code === '000000' ? '111111' : '000000';

    await expect(
      service.verify(issued.requestId, PHONE, wrong),
    ).rejects.toThrow('Incorrect verification code');
    await service.verify(issued.requestId, PHONE, code);

    assertClean(code);
    assertClean(wrong);
  });

  it('a failed SMS job logs the job id and the provider error, with the number masked', async () => {
    const provider = new EskizSmsProvider({
      baseUrl: 'https://example.invalid',
      email: 'e',
      password: 'p',
    });
    // A number the provider refuses: its error names the number.
    const err = await provider
      .send('+1901234567890', 'Mator: kod 482913')
      .catch((e: Error) => e);
    expect((err as Error).message).not.toContain('1901234567890');

    const processor = new SmsProcessor({} as never, {} as never);
    processor.onFailed(
      { id: 'job_9', opts: { attempts: 3 }, attemptsMade: 3 } as never,
      err as Error,
    );
    const all = lines.join('\n');
    expect(all).toContain('job_9');
    expect(all).not.toContain('1901234567890');
    expect(all).not.toContain('482913');
  });
});
