// INFO-12: the BFL API key only ever goes to BFL's API, over https, with no
// redirect, to a public address. No FLUX quota or budget is involved.

import axios from 'axios';
import {
  downloadUrlProblem,
  isPublicAddress,
  pollingUrlProblem,
  publicOnlyLookup,
} from './bfl-url-policy';
import {
  ImageEnhanceError,
  ImageEnhanceService,
} from './image-enhance.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;
const actualAxios = jest.requireActual<typeof import('axios')>('axios');

describe('polling URL policy', () => {
  it.each([
    'https://api.bfl.ai/v1/get_result?id=1',
    'https://api.us1.bfl.ai/v1/get_result?id=1',
    'https://api.eu1.bfl.ai/v1/get_result?id=1',
    'https://API.EU.bfl.ai/v1/get_result?id=1',
  ])('trusts BFL API host %s', (url) => {
    expect(pollingUrlProblem(url)).toBeNull();
  });

  it.each([
    ['http://api.bfl.ai/v1/get_result', 'not https'],
    ['https://evil.example/v1/get_result', 'host not trusted'],
    ['https://api.bfl.ai.evil.example/x', 'host not trusted'],
    ['https://bfl.ai.evil.example/x', 'host not trusted'],
    ['https://evilapi.bfl.ai/x', 'host not trusted'],
    ['https://delivery.bfl.ai/x', 'host not trusted'],
    ['https://api.bfl.ai:8443/x', 'non-default port'],
    ['https://user:pw@api.bfl.ai/x', 'credentials in URL'],
    ['https://127.0.0.1/x', 'IP address host'],
    ['https://[::1]/x', 'IP address host'],
    ['https://169.254.169.254/latest/meta-data', 'IP address host'],
    ['not a url', 'not a URL'],
  ])('refuses %s (%s)', (url, reason) => {
    expect(pollingUrlProblem(url)).toBe(reason);
  });

  it('trusts an extra host only when BFL_POLLING_ALLOWED_HOSTS names it', () => {
    const previous = process.env.BFL_POLLING_ALLOWED_HOSTS;
    process.env.BFL_POLLING_ALLOWED_HOSTS = 'jobs.example-bfl.net';
    try {
      expect(pollingUrlProblem('https://jobs.example-bfl.net/r')).toBeNull();
      expect(pollingUrlProblem('https://other.example-bfl.net/r')).toBe(
        'host not trusted',
      );
    } finally {
      if (previous === undefined) delete process.env.BFL_POLLING_ALLOWED_HOSTS;
      else process.env.BFL_POLLING_ALLOWED_HOSTS = previous;
    }
  });

  it('the result download must be https too', () => {
    expect(
      downloadUrlProblem('https://delivery-eu1.bfl.ai/r.png?sig=x'),
    ).toBeNull();
    expect(downloadUrlProblem('http://delivery-eu1.bfl.ai/r.png')).toBe(
      'not https',
    );
    expect(downloadUrlProblem('file:///etc/passwd')).toBe('not https');
  });
});

describe('public-address lookup', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
  ])('treats %s as non-public', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each(['8.8.8.8', '104.18.1.1', '2606:4700::1111'])(
    'treats %s as public',
    (ip) => {
      expect(isPublicAddress(ip)).toBe(true);
    },
  );

  it('refuses a name that resolves to an internal address', (done) => {
    publicOnlyLookup('localhost', {}, (err) => {
      expect(err).toMatchObject({ code: 'ENONPUBLIC' });
      done();
    });
  });
});

describe('ImageEnhanceService never forwards the key to an untrusted destination', () => {
  const KEY = 'bfl-test-key';
  const OLD = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    mockedAxios.isAxiosError.mockImplementation((p) =>
      actualAxios.isAxiosError(p),
    );
    process.env = { ...OLD, BFL_API_KEY: KEY };
  });
  afterAll(() => {
    process.env = OLD;
  });

  it.each([
    'https://evil.example/v1/get_result?id=1',
    'http://api.bfl.ai/v1/get_result?id=1',
    'https://169.254.169.254/latest',
  ])(
    'a polling_url of %s is refused before any request carries the key',
    async (url) => {
      mockedAxios.post.mockResolvedValue({ data: { polling_url: url } });

      const error = await new ImageEnhanceService()
        .removeBackground(Buffer.from('x'))
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ImageEnhanceError);
      expect((error as ImageEnhanceError).retryable).toBe(false);
      expect((error as Error).message).toContain('untrusted polling_url');
      expect((error as Error).message).not.toContain(KEY);
      expect(mockedAxios.get).not.toHaveBeenCalled();
    },
  );

  it('submit and poll requests follow no redirect, and poll uses the public-only agent', async () => {
    jest.useFakeTimers();
    try {
      mockedAxios.post.mockResolvedValue({
        data: { polling_url: 'https://api.us1.bfl.ai/v1/get_result?id=1' },
      });
      mockedAxios.get
        .mockResolvedValueOnce({
          status: 200,
          data: {
            status: 'Ready',
            result: { sample: 'https://delivery-us1.bfl.ai/r.png' },
          },
        })
        .mockResolvedValueOnce({
          status: 200,
          data: new Uint8Array([1, 2, 3]).buffer,
        });

      const run = new ImageEnhanceService().removeBackground(Buffer.from('x'));
      await jest.runAllTimersAsync();
      await run;

      const submitOpts = mockedAxios.post.mock.calls[0][2] as Record<
        string,
        unknown
      >;
      expect(submitOpts.maxRedirects).toBe(0);
      const [pollUrl, pollOpts] = mockedAxios.get.mock.calls[0] as [
        string,
        Record<string, any>,
      ];
      expect(pollUrl).toBe('https://api.us1.bfl.ai/v1/get_result?id=1');
      expect(pollOpts.maxRedirects).toBe(0);
      expect(pollOpts.httpsAgent).toBeDefined();
      expect(pollOpts.headers['x-key']).toBe(KEY);
      // The download is not given the key.
      const [, downloadOpts] = mockedAxios.get.mock.calls[1] as [
        string,
        Record<string, any>,
      ];
      expect(downloadOpts.headers?.['x-key']).toBeUndefined();
      expect(downloadOpts.httpsAgent).toBeDefined();
    } finally {
      jest.useRealTimers();
    }
  });
});
