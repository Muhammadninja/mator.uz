import axios from 'axios';
import { EskizSmsProvider } from './eskiz.provider';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Provider uses axios.isAxiosError to branch 401 / terminal 4xx / transient 5xx.
(mockedAxios.isAxiosError as unknown as jest.Mock).mockImplementation(
  (e: unknown) => !!(e as { isAxiosError?: boolean })?.isAxiosError,
);

const cfg = {
  baseUrl: 'https://notify.eskiz.uz/api',
  email: 'bot@mator.uz',
  password: 'secret',
};

const AUTH_URL = 'https://notify.eskiz.uz/api/auth/login';
const SEND_URL = 'https://notify.eskiz.uz/api/message/sms/send';

const axiosError = (status: number, data?: unknown) => ({
  isAxiosError: true,
  message: `Request failed with status code ${status}`,
  response: { status, data },
});

/** A successful /auth/login body. */
const authOk = (token = 'tok-1') => ({ data: { data: { token } } });
/** An accepted /message/sms/send body. */
const sendOk = (id: string | number = 'msg-1') => ({
  data: { id, status: 'waiting', message: 'Waiting for SMS provider' },
});

/** Calls made to the auth endpoint / the send endpoint. */
const callsTo = (url: string) =>
  mockedAxios.post.mock.calls.filter((c) => c[0] === url);

describe('EskizSmsProvider', () => {
  let provider: EskizSmsProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new EskizSmsProvider(cfg);
  });

  describe('authentication', () => {
    it('logs in with email/password and sends the bearer token on the send call', async () => {
      mockedAxios.post
        .mockResolvedValueOnce(authOk('tok-abc'))
        .mockResolvedValueOnce(sendOk());

      await provider.send('+998901234567', 'code 123456');

      const [authUrl, authBody, authCfg] = mockedAxios.post.mock.calls[0];
      expect(authUrl).toBe(AUTH_URL);
      expect(authBody).toEqual({ email: 'bot@mator.uz', password: 'secret' });
      expect((authCfg as { timeout: number }).timeout).toBe(10_000);

      const [sendUrl, sendBody, sendCfg] = mockedAxios.post.mock.calls[1];
      expect(sendUrl).toBe(SEND_URL);
      expect(sendBody).toEqual({
        mobile_phone: '998901234567',
        message: 'code 123456',
        from: '4546',
      });
      expect(
        (sendCfg as { headers: Record<string, string> }).headers.Authorization,
      ).toBe('Bearer tok-abc');
    });

    it('caches the token — a second send does NOT hit /auth/login again', async () => {
      mockedAxios.post
        .mockResolvedValueOnce(authOk())
        .mockResolvedValueOnce(sendOk())
        .mockResolvedValueOnce(sendOk('msg-2'));

      await provider.send('+998901234567', 'hi');
      await provider.send('+998901234567', 'hi again');

      expect(callsTo(AUTH_URL)).toHaveLength(1);
      expect(callsTo(SEND_URL)).toHaveLength(2);
    });

    it('throws when the auth response carries no token', async () => {
      mockedAxios.post.mockResolvedValueOnce({ data: { data: {} } });

      await expect(provider.send('+998901234567', 'hi')).rejects.toThrow(
        /Eskiz auth returned no token/,
      );
      expect(callsTo(SEND_URL)).toHaveLength(0);
    });

    it('does not cache a failed login — the next send retries the auth cleanly', async () => {
      mockedAxios.post.mockRejectedValueOnce(new Error('network down'));
      await expect(provider.send('+998901234567', 'hi')).rejects.toThrow(
        /network down/,
      );

      mockedAxios.post
        .mockResolvedValueOnce(authOk('tok-2'))
        .mockResolvedValueOnce(sendOk());
      const result = await provider.send('+998901234567', 'hi');

      expect(result.providerSmsId).toBe('msg-1');
      expect(callsTo(AUTH_URL)).toHaveLength(2);
    });

    it('coalesces concurrent logins into ONE /auth/login request', async () => {
      // Three parallel sends on a cold provider: all need a token at once.
      let releaseAuth: (v: unknown) => void = () => undefined;
      const pendingAuth = new Promise((resolve) => {
        releaseAuth = resolve;
      });

      mockedAxios.post.mockImplementation((url: string) => {
        if (url === AUTH_URL) return pendingAuth;
        return Promise.resolve(sendOk());
      });

      const sends = Promise.all([
        provider.send('+998901234567', 'a'),
        provider.send('+998901234568', 'b'),
        provider.send('+998901234569', 'c'),
      ]);

      // Let the three sends reach their await before the login resolves.
      await Promise.resolve();
      releaseAuth(authOk('shared-tok'));
      await sends;

      expect(callsTo(AUTH_URL)).toHaveLength(1);
      expect(callsTo(SEND_URL)).toHaveLength(3);
      for (const call of callsTo(SEND_URL)) {
        expect(
          (call[2] as { headers: Record<string, string> }).headers
            .Authorization,
        ).toBe('Bearer shared-tok');
      }
    });
  });

  describe('response-body validation (Eskiz answers 200 for rejections too)', () => {
    it('returns the message id as providerSmsId (verbatim, not fabricated)', async () => {
      mockedAxios.post
        .mockResolvedValueOnce(authOk())
        .mockResolvedValueOnce(sendOk('msg-42'));

      const result = await provider.send('+998901234567', 'code 123456');

      expect(result).toEqual({
        providerTransactionId: null,
        providerSmsId: 'msg-42',
        parts: null,
      });
    });

    it('stringifies a numeric id', async () => {
      mockedAxios.post
        .mockResolvedValueOnce(authOk())
        .mockResolvedValueOnce(sendOk(778899));

      const result = await provider.send('+998901234567', 'hi');

      expect(result.providerSmsId).toBe('778899');
    });

    it('throws on a 200 whose body reports status="error" (unmoderated template)', async () => {
      mockedAxios.post.mockResolvedValueOnce(authOk()).mockResolvedValueOnce({
        data: { status: 'error', message: 'Message text is not allowed' },
      });

      await expect(provider.send('+998901234567', 'hi')).rejects.toThrow(
        /Eskiz send rejected \(status="error"\): Message text is not allowed/,
      );
    });

    it('throws on a 200 with neither id nor status rather than reporting a phantom success', async () => {
      mockedAxios.post
        .mockResolvedValueOnce(authOk())
        .mockResolvedValueOnce({ data: {} });

      await expect(provider.send('+998901234567', 'hi')).rejects.toThrow(
        /returned no id or status/,
      );
    });

    it('does not retry a body-level rejection (it is terminal, not transient)', async () => {
      mockedAxios.post.mockResolvedValueOnce(authOk()).mockResolvedValueOnce({
        data: { status: 'error', message: 'no balance' },
      });

      await expect(provider.send('+998901234567', 'hi')).rejects.toThrow(
        /no balance/,
      );
      expect(callsTo(SEND_URL)).toHaveLength(1);
    });
  });

  describe('input guards', () => {
    it('rejects a non-Uzbek / malformed phone without calling the API', async () => {
      await expect(provider.send('+12025550123', 'hi')).rejects.toThrow(
        /unsupported phone format/,
      );
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('rejects an empty body without calling the API', async () => {
      await expect(provider.send('+998901234567', '')).rejects.toThrow(
        /empty SMS body/,
      );
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('normalizes a trailing slash on baseUrl (no double slash)', async () => {
      mockedAxios.post
        .mockResolvedValueOnce(authOk())
        .mockResolvedValueOnce(sendOk());
      const p = new EskizSmsProvider({
        ...cfg,
        baseUrl: 'https://notify.eskiz.uz/api/',
      });

      await p.send('+998901234567', 'hi');

      expect(mockedAxios.post.mock.calls[0][0]).toBe(AUTH_URL);
      expect(mockedAxios.post.mock.calls[1][0]).toBe(SEND_URL);
    });

    it('sends the configured alpha-name instead of the 4546 test sender', async () => {
      mockedAxios.post
        .mockResolvedValueOnce(authOk())
        .mockResolvedValueOnce(sendOk());
      const p = new EskizSmsProvider({ ...cfg, from: 'MATOR' });

      await p.send('+998901234567', 'hi');

      expect((mockedAxios.post.mock.calls[1][1] as { from: string }).from).toBe(
        'MATOR',
      );
    });

    it('sends callback_url when configured', async () => {
      mockedAxios.post
        .mockResolvedValueOnce(authOk())
        .mockResolvedValueOnce(sendOk());
      const p = new EskizSmsProvider({
        ...cfg,
        callbackUrl: 'https://api.mator.uz/v1/sms/webhooks/eskiz',
      });

      await p.send('+998901234567', 'hi');

      expect(
        (mockedAxios.post.mock.calls[1][1] as { callback_url?: string })
          .callback_url,
      ).toBe('https://api.mator.uz/v1/sms/webhooks/eskiz');
    });

    it('omits callback_url entirely when not configured (payload unchanged)', async () => {
      mockedAxios.post
        .mockResolvedValueOnce(authOk())
        .mockResolvedValueOnce(sendOk());

      await provider.send('+998901234567', 'hi');

      const body = mockedAxios.post.mock.calls[1][1] as Record<string, string>;
      expect(body).not.toHaveProperty('callback_url');
      expect(Object.keys(body).sort()).toEqual(['from', 'message', 'mobile_phone']);
    });
  });

  describe('401 handling', () => {
    it('re-authenticates once on 401 and replays the send with the fresh token', async () => {
      mockedAxios.post
        .mockResolvedValueOnce(authOk('stale')) // initial login
        .mockRejectedValueOnce(axiosError(401)) // send with stale token
        .mockResolvedValueOnce(authOk('fresh')) // re-login
        .mockResolvedValueOnce(sendOk('msg-7')); // replayed send

      const result = await provider.send('+998901234567', 'hi');

      expect(result.providerSmsId).toBe('msg-7');
      expect(callsTo(AUTH_URL)).toHaveLength(2);
      const sends = callsTo(SEND_URL);
      expect(sends).toHaveLength(2);
      expect(
        (sends[1][2] as { headers: Record<string, string> }).headers
          .Authorization,
      ).toBe('Bearer fresh');
    });

    it('surfaces a failing re-authentication instead of looping', async () => {
      mockedAxios.post
        .mockResolvedValueOnce(authOk('stale'))
        .mockRejectedValueOnce(axiosError(401))
        .mockRejectedValueOnce(new Error('auth endpoint down'));

      await expect(provider.send('+998901234567', 'hi')).rejects.toThrow(
        /auth endpoint down/,
      );
      expect(callsTo(SEND_URL)).toHaveLength(1);
    });

    it('gives up on a second 401 (credentials are wrong, not the token)', async () => {
      mockedAxios.post
        .mockResolvedValueOnce(authOk('t1'))
        .mockRejectedValueOnce(axiosError(401))
        .mockResolvedValueOnce(authOk('t2'))
        .mockRejectedValueOnce(
          axiosError(401, { message: 'Unauthenticated.' }),
        );

      await expect(provider.send('+998901234567', 'hi')).rejects.toThrow(
        /HTTP 401.*Unauthenticated/,
      );
      expect(callsTo(AUTH_URL)).toHaveLength(2);
      expect(callsTo(SEND_URL)).toHaveLength(2);
    });
  });

  describe('terminal 4xx', () => {
    it('fails fast on 400 with the gateway message (no retry)', async () => {
      mockedAxios.post
        .mockResolvedValueOnce(authOk())
        .mockRejectedValueOnce(
          axiosError(400, { message: 'mobile_phone is invalid' }),
        );

      await expect(provider.send('+998901234567', 'hi')).rejects.toThrow(
        /HTTP 400\): mobile_phone is invalid/,
      );
      expect(callsTo(SEND_URL)).toHaveLength(1);
    });

    it('fails fast on 402 (no balance) without retry', async () => {
      mockedAxios.post
        .mockResolvedValueOnce(authOk())
        .mockRejectedValueOnce(
          axiosError(402, { message: 'Insufficient funds' }),
        );

      await expect(provider.send('+998901234567', 'hi')).rejects.toThrow(
        /HTTP 402/,
      );
      expect(callsTo(SEND_URL)).toHaveLength(1);
    });
  });

  describe('transient failures (fake timers, no real backoff wait)', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    // Runs the promise while auto-advancing timers so backoff sleeps resolve.
    const runWithTimers = async (promise: Promise<unknown>) => {
      const settled = promise.then(
        (v: unknown) => ({ ok: true, v, e: undefined as Error | undefined }),
        (e: Error) => ({ ok: false, v: undefined as unknown, e }),
      );
      await jest.runAllTimersAsync();
      return settled;
    };

    it('retries a 5xx then succeeds', async () => {
      mockedAxios.post
        .mockResolvedValueOnce(authOk())
        .mockRejectedValueOnce(axiosError(503))
        .mockResolvedValueOnce(sendOk('msg-9'));

      const res = await runWithTimers(provider.send('+998901234567', 'hi'));

      expect(res.ok).toBe(true);
      expect(callsTo(SEND_URL)).toHaveLength(2);
      // A 5xx must not trigger a re-login — the token is still good.
      expect(callsTo(AUTH_URL)).toHaveLength(1);
    });

    it('gives up after MAX_ATTEMPTS on persistent 5xx', async () => {
      mockedAxios.post
        .mockResolvedValueOnce(authOk())
        .mockRejectedValue(axiosError(500));

      const res = await runWithTimers(provider.send('+998901234567', 'hi'));

      expect(res.ok).toBe(false);
      expect(res.e?.message).toMatch(/Request failed with status code 500/);
      expect(callsTo(SEND_URL)).toHaveLength(3);
    });

    it('retries a network error (no response) and succeeds', async () => {
      mockedAxios.post
        .mockResolvedValueOnce(authOk())
        .mockRejectedValueOnce({ isAxiosError: true, message: 'ETIMEDOUT' })
        .mockResolvedValueOnce(sendOk('msg-10'));

      const res = await runWithTimers(provider.send('+998901234567', 'hi'));

      expect(res.ok).toBe(true);
      expect(callsTo(SEND_URL)).toHaveLength(2);
    });
  });
});
