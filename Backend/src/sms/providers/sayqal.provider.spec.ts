import axios from 'axios';
import { createHash } from 'crypto';
import { SayqalSmsProvider } from './sayqal.provider';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Provider uses axios.isAxiosError to branch terminal vs transient failures.
(mockedAxios.isAxiosError as unknown as jest.Mock).mockImplementation(
  (e: unknown) => !!(e as { isAxiosError?: boolean })?.isAxiosError,
);

const cfg = {
  baseUrl: 'https://routee.sayqal.uz',
  username: 'test',
  secretKey: 'secret',
  serviceId: 1,
};

// The body sent to axios.post; typed so we can assert on its shape.
interface SentBody {
  utime: number;
  username: string;
  service: { service: number; nickname?: string };
  message: { smsid: string; phone: string; text: string };
}
const sentBody = (callIndex: number): SentBody =>
  mockedAxios.post.mock.calls[callIndex][1] as SentBody;

const axiosError = (status: number, data?: unknown) => ({
  isAxiosError: true,
  message: `Request failed with status code ${status}`,
  response: { status, data },
});

describe('SayqalSmsProvider', () => {
  let provider: SayqalSmsProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new SayqalSmsProvider(cfg);
  });

  it('posts to /sms/TransmitSMS with a matching md5 X-Access-Token and 998-digit phone', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { transactionid: '1', smsid: '1', parts: 1 } });

    await provider.send('+998901234567', 'code 123456');

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    const [url, , config] = mockedAxios.post.mock.calls[0];
    const body = sentBody(0);
    expect(url).toBe('https://routee.sayqal.uz/sms/TransmitSMS');
    expect(body.message.phone).toBe('998901234567');
    expect(body.username).toBe('test');
    expect(body.service).toEqual({ service: 1 });

    // Token must be md5("TransmitSMS {username} {secretKey} {utime}") with the
    // exact utime that is sent in the body.
    const expected = createHash('md5')
      .update(`TransmitSMS test secret ${body.utime}`)
      .digest('hex');
    expect(config?.headers?.['X-Access-Token']).toBe(expected);
  });

  it('returns the API transactionid/smsid/parts as send metadata (verbatim, not fabricated)', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { transactionid: 'tx-9', smsid: 'sms-9', parts: 2 },
    });

    const result = await provider.send('+998901234567', 'code 123456');

    expect(result).toEqual({
      providerTransactionId: 'tx-9',
      providerSmsId: 'sms-9',
      parts: 2,
    });
  });

  it('includes nickname only when configured', async () => {
    mockedAxios.post.mockResolvedValue({ data: { transactionid: '1', smsid: '1', parts: 1 } });

    await provider.send('+998901234567', 'hi');
    expect(sentBody(0).service.nickname).toBeUndefined();

    const withNick = new SayqalSmsProvider({ ...cfg, nickname: 'Mator' });
    await withNick.send('+998901234567', 'hi');
    expect(sentBody(1).service.nickname).toBe('Mator');
  });

  it('rejects a non-Uzbek / malformed phone without calling the API', async () => {
    await expect(provider.send('+12025550123', 'hi')).rejects.toThrow(/unsupported phone format/);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('fails fast on 400 with the gateway error message (no retry)', async () => {
    mockedAxios.post.mockRejectedValueOnce(
      axiosError(400, { errorCode: 110, errMsg: 'INVALID PARAM. Incorrect value of "username"' }),
    );

    await expect(provider.send('+998901234567', 'hi')).rejects.toThrow(
      /HTTP 400.*\[110\].*Incorrect value of "username"/,
    );
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  it('fails fast on 403 (bad token) without retry', async () => {
    mockedAxios.post.mockRejectedValueOnce(axiosError(403));
    await expect(provider.send('+998901234567', 'hi')).rejects.toThrow(/HTTP 403/);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty body without calling the API', async () => {
    await expect(provider.send('+998901234567', '')).rejects.toThrow(/empty SMS body/);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('normalizes a trailing slash on baseUrl (no double slash)', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { transactionid: '1', smsid: '1', parts: 1 } });
    const p = new SayqalSmsProvider({ ...cfg, baseUrl: 'https://routee.sayqal.uz/' });
    await p.send('+998901234567', 'hi');
    expect(mockedAxios.post.mock.calls[0][0]).toBe('https://routee.sayqal.uz/sms/TransmitSMS');
  });

  describe('retry behaviour (fake timers, no real backoff wait)', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    // Runs the promise while auto-advancing timers so backoff sleeps resolve.
    const runWithTimers = async (promise: Promise<unknown>) => {
      const settled = promise.then(
        (v) => ({ ok: true, v }),
        (e) => ({ ok: false, e }),
      );
      await jest.runAllTimersAsync();
      return settled;
    };

    it('retries transient 5xx failures then succeeds', async () => {
      mockedAxios.post
        .mockRejectedValueOnce(axiosError(503))
        .mockResolvedValueOnce({ data: { transactionid: '9', smsid: '9', parts: 1 } });

      const res = await runWithTimers(provider.send('+998901234567', 'hi'));
      expect(res.ok).toBe(true);
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    });

    it('reuses the SAME smsid across retries so the gateway can dedupe (no duplicate OTP)', async () => {
      mockedAxios.post
        .mockRejectedValueOnce(axiosError(500))
        .mockRejectedValueOnce(axiosError(502))
        .mockResolvedValueOnce({ data: { transactionid: '3', smsid: '3', parts: 1 } });

      await runWithTimers(provider.send('+998901234567', 'hi'));
      const ids = mockedAxios.post.mock.calls.map((c) => (c[1] as SentBody).message.smsid);
      expect(ids).toHaveLength(3);
      expect(new Set(ids).size).toBe(1); // identical across all attempts
    });

    it('mints a fresh utime+token per attempt (both stay in sync)', async () => {
      mockedAxios.post
        .mockRejectedValueOnce(axiosError(500))
        .mockResolvedValueOnce({ data: { transactionid: '4', smsid: '4', parts: 1 } });

      await runWithTimers(provider.send('+998901234567', 'hi'));
      for (const call of mockedAxios.post.mock.calls) {
        const body = call[1] as SentBody;
        const header = (call[2] as { headers: Record<string, string> }).headers['X-Access-Token'];
        const expected = createHash('md5')
          .update(`TransmitSMS test secret ${body.utime}`)
          .digest('hex');
        expect(header).toBe(expected);
      }
    });

    it('gives up after MAX_ATTEMPTS on persistent 5xx', async () => {
      mockedAxios.post.mockRejectedValue(axiosError(500));
      const res = await runWithTimers(provider.send('+998901234567', 'hi'));
      expect(res.ok).toBe(false);
      expect((res as { e: Error }).e.message).toMatch(/Sayqal SMS delivery failed/);
      expect(mockedAxios.post).toHaveBeenCalledTimes(3);
    });
  });
});
