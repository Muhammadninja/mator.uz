// Tests for the ImageEnhanceService (FLUX.2 Pro): submit the base64 image with
// the catalog-photo prompt, width=height=1000, and output_format=png; poll the
// returned polling_url until Ready; then download the signed result URL and
// return that PNG buffer (a 1000×1000 product photo on a white background).
// Failures carry a `retryable` flag (the image worker turns it into "retry" or
// "fail now") and never carry the API key. All HTTP calls (axios.post /
// axios.get) are mocked — no network, no paid BFL calls. The poll loop sleeps
// between GETs, so every run is driven by fake timers.

import axios from 'axios';
import {
  ImageEnhanceError,
  ImageEnhanceService,
} from './image-enhance.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;
const actualAxios = jest.requireActual<typeof import('axios')>('axios');

const KEY = 'bfl-test-key';
const POLL = 'https://api.us1.bfl.ai/v1/get_result?id=job-1';
const SAMPLE = 'https://delivery.bfl.ai/results/out.png?sig=abc';

const OLD_ENV = process.env;

beforeEach(() => {
  jest.resetAllMocks();
  jest.useFakeTimers();
  // The service classifies failures with axios.isAxiosError; keep the real one.
  mockedAxios.isAxiosError.mockImplementation((payload) =>
    actualAxios.isAxiosError(payload),
  );
  process.env = { ...OLD_ENV, BFL_API_KEY: KEY };
});

afterEach(() => {
  jest.useRealTimers();
});

afterAll(() => {
  process.env = OLD_ENV;
});

/** Run removeBackground to the end, driving the fake clock its poll loop sleeps on. */
async function enhance(input = Buffer.from('x')): Promise<Buffer> {
  const result = new ImageEnhanceService().removeBackground(input);
  result.catch(() => undefined); // the caller asserts the outcome
  await jest.runAllTimersAsync();
  return result;
}

/** The ImageEnhanceError a failing run rejects with. */
async function failure(): Promise<ImageEnhanceError> {
  const error = await enhance().then(
    () => {
      throw new Error('expected removeBackground to fail');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ImageEnhanceError);
  return error as ImageEnhanceError;
}

/** An axios-shaped HTTP error response (the real isAxiosError accepts it). */
function httpError(status: number, data: unknown = { detail: 'nope' }) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data },
  });
}

/** An axios-shaped error with no response: a timeout or network failure. */
function noResponseError(code: string) {
  return Object.assign(new Error(code), { isAxiosError: true, code });
}

const submitted = () => ({ data: { id: 'job-1', polling_url: POLL } });
const ready = () => ({ data: { status: 'Ready', result: { sample: SAMPLE } } });

/** The submitted JSON body. */
function submittedBody(): Record<string, unknown> {
  return mockedAxios.post.mock.calls[0][1] as Record<string, unknown>;
}

/** The x-key header sent with a request config, if any. */
function xKey(config: unknown): unknown {
  return (config as { headers?: Record<string, unknown> } | undefined)
    ?.headers?.['x-key'];
}

describe('ImageEnhanceService configuration', () => {
  it('throws when BFL_API_KEY is missing', () => {
    delete process.env.BFL_API_KEY;
    expect(() => new ImageEnhanceService()).toThrow('BFL_API_KEY is not set');
  });
});

describe('ImageEnhanceService.removeBackground', () => {
  it('submits the base64 image to FLUX.2 Pro, polls until Ready, and returns the PNG unchanged', async () => {
    const source = Buffer.from('source-png');
    const png = Buffer.from('WHITE_BG_PNG_BYTES');

    mockedAxios.post.mockResolvedValueOnce(submitted());
    // Every "still working" status keeps it polling — proves it actually polls.
    mockedAxios.get
      .mockResolvedValueOnce({ data: { status: 'Pending' } })
      .mockResolvedValueOnce({ data: { status: 'Reasoning' } })
      .mockResolvedValueOnce({ data: { status: 'Generating' } })
      .mockResolvedValueOnce(ready())
      .mockResolvedValueOnce({ data: png }); // the image download

    const out = await enhance(source);

    // Returned byte-for-byte, no post-processing.
    expect(out.equals(png)).toBe(true);

    // Submit: the FLUX.2 Pro endpoint with x-key auth.
    expect(mockedAxios.post.mock.calls).toHaveLength(1);
    const [url, , config] = mockedAxios.post.mock.calls[0];
    expect(url).toBe('https://api.bfl.ai/v1/flux-2-pro');
    expect(xKey(config)).toBe(KEY);

    // Exactly the FLUX.2 fields: the photo as base64 in input_image, the exact
    // 1000×1000 canvas and PNG output — nothing else is sent.
    const body = submittedBody();
    expect(Object.keys(body).sort()).toEqual([
      'height',
      'input_image',
      'output_format',
      'prompt',
      'width',
    ]);
    expect(body.input_image).toBe(source.toString('base64'));
    expect(body.width).toBe(1000);
    expect(body.height).toBe(1000);
    expect(body.output_format).toBe('png');

    // Polled the returned polling_url with the key, then downloaded the signed
    // sample URL WITHOUT it — the key only ever goes to BFL's API.
    const gets = mockedAxios.get.mock.calls;
    expect(gets.map(([u]) => u)).toEqual([POLL, POLL, POLL, POLL, SAMPLE]);
    expect(xKey(gets[0][1])).toBe(KEY);
    expect(xKey(gets[4][1])).toBeUndefined();
    expect(gets[4][1]?.responseType).toBe('arraybuffer');
  });

  // What FLUX may change is decided by the prompt alone. These tests pin its
  // key requirements rather than its wording: only the background changes, the
  // part is asked to stay exactly as photographed, and nothing asks to clean,
  // enhance, restore or modify it. They cannot judge a generated image — only a
  // real FLUX run on control photos can.
  describe('the catalog-photo prompt', () => {
    /** Run one successful edit and return the prompt it submitted. */
    async function sentPrompt(): Promise<string> {
      mockedAxios.post.mockResolvedValueOnce(submitted());
      mockedAxios.get
        .mockResolvedValueOnce(ready())
        .mockResolvedValueOnce({ data: Buffer.from('png') });
      await enhance();
      return submittedBody().prompt as string;
    }

    /** The prompt's sentences. */
    function sentences(prompt: string): string[] {
      return prompt.split(/\.\s+/);
    }

    /** The first sentence of the prompt that matches `pattern`. */
    function sentence(prompt: string, pattern: RegExp): string {
      const found = sentences(prompt).find((s) => pattern.test(s));
      if (found === undefined) {
        throw new Error(`no sentence matches /${pattern.source}/`);
      }
      return found;
    }

    // Each behavior is one instruction in the prompt, and it must name every item.
    it.each<[string, RegExp, string[]]>([
      [
        'isolates the part and places it on a flat pure white background',
        /^Isolate\b/,
        [
          'automotive spare part',
          'input image',
          'flat pure white (#FFFFFF) background',
        ],
      ],
      [
        'only the original background, hands and surroundings are replaced',
        /^Only the original background\b/,
        ['original background', 'hands', 'surroundings', 'replaced'],
      ],
      [
        'geometry, shape, proportions, materials, colors and texture stay as photographed',
        /^The part stays\b/,
        [
          'exactly as photographed',
          'geometry',
          'shape',
          'proportions',
          'materials',
          'colors',
          'texture',
        ],
      ],
      [
        'components, holes, threads, connectors, mounting points and fasteners stay',
        /^The part stays\b/,
        [
          'number of components',
          'holes',
          'threads',
          'connectors',
          'mounting points',
          'fasteners',
        ],
      ],
      [
        'rust, dirt, dust, grease, scratches, scuffs, cracks and damage stay',
        /^The part stays\b/,
        [
          'every surface detail',
          'rust',
          'dirt',
          'dust',
          'grease',
          'scratches',
          'scuffs',
          'cracks',
          'damage',
          'all unchanged',
        ],
      ],
      [
        'logos, OEM / GM numbers, labels and markings keep their exact characters',
        /^Every logo\b/,
        [
          'logo',
          'OEM and GM number',
          'label',
          'marking',
          'exact characters',
          'blurry or unreadable text included',
        ],
      ],
      [
        'no detail is invented',
        /^Show only\b/,
        ['details visible in the input image'],
      ],
      [
        'the part sits centered on a 1000×1000 canvas at its own proportions',
        /^Output\b/,
        [
          'exactly 1000×1000 pixels',
          'centered',
          '85–90%',
          'proportions unchanged',
        ],
      ],
    ])('%s', async (_behavior, pattern, items) => {
      const instruction = sentence(await sentPrompt(), pattern);
      for (const item of items) {
        expect(instruction).toContain(item);
      }
    });

    it('names rust, dirt, scratches and damage only as things that stay', async () => {
      const mentions = sentences(await sentPrompt()).filter((s) =>
        /\b(rust|dirt|dust|grease|scratch\w*|scuff\w*|crack\w*|damage)\b/i.test(
          s,
        ),
      );
      expect(mentions).toHaveLength(1);
      expect(mentions[0]).toMatch(
        /^The part stays exactly as photographed\b[\s\S]*\ball unchanged$/,
      );
    });

    it('asks for no cleaning, enhancement, restoration or retouching of the part', async () => {
      // Not even named: FLUX.2 has no negative prompt, and naming a thing tends
      // to draw the model toward it. The rule is stated as "unchanged" instead.
      expect(await sentPrompt()).not.toMatch(
        /\b(clean\w*|enhanc\w*|improv\w*|restor\w*|repair\w*|retouch\w*|reconstruct\w*|rebuil\w*|refurbish\w*|renew\w*|polish\w*|beautif\w*|denois\w*|brighten\w*|correct\w*|recolor\w*|upscal\w*|fix\w*)\b/i,
      );
    });

    it('asks for no removal, addition or modification of anything on the part', async () => {
      expect(await sentPrompt()).not.toMatch(
        /\b(remov\w*|eras\w*|delet\w*|eliminat\w*|add\w*|insert\w*|modif\w*|alter\w*|chang\w*|adjust\w*|edit\w*|redesign\w*|redraw\w*|regenerat\w*|recreat\w*|invent\w*)\b/i,
      );
    });

    it('gives no lighting, exposure, color or noise instruction that would alter the part', async () => {
      expect(await sentPrompt()).not.toMatch(
        /\b(exposure|lighting|white balance|noise|contrast|brightness|saturation|color (accuracy|balance|grading|correction))\b/i,
      );
    });

    it('stays within 120 words and has no "sharp…" wording', async () => {
      const prompt = await sentPrompt();
      expect(prompt.trim().split(/\s+/).length).toBeLessThanOrEqual(120);
      // "sharpness" stays out so the model does not read it as license to
      // reconstruct local detail, text included — no "sharp…" word at all.
      expect(prompt).not.toMatch(/sharp/i);
    });
  });

  it.each([
    [400, false],
    [401, false],
    [402, false],
    [403, false],
    [404, false],
    [422, false],
    [408, true],
    [429, true],
    [500, true],
    [502, true],
    [503, true],
  ])('submit HTTP %i → retryable=%p', async (status, retryable) => {
    mockedAxios.post.mockRejectedValueOnce(httpError(status));

    const error = await failure();

    expect(error.retryable).toBe(retryable);
    expect(error.message).toContain(
      `FLUX.2 Pro edit failed — submit HTTP ${status}: {"detail":"nope"}`,
    );
    expect(mockedAxios.get.mock.calls).toHaveLength(0); // nothing polled
  });

  it.each([
    [401, 'check BFL_API_KEY'],
    [403, 'check BFL_API_KEY'],
    [402, 'out of credits'],
    [429, 'rate limit'],
  ])(
    'names the likely cause of HTTP %i for the server log',
    async (status, hint) => {
      mockedAxios.post.mockRejectedValueOnce(httpError(status));
      expect((await failure()).message).toContain(hint);
    },
  );

  it('never puts the API key in the error, even when BFL echoes it back', async () => {
    mockedAxios.post.mockRejectedValueOnce(
      httpError(401, { detail: `Invalid key ${KEY}` }),
    );

    const error = await failure();

    expect(error.message).not.toContain(KEY);
    expect(error.stack ?? '').not.toContain(KEY);
    expect(error.message).toContain('[REDACTED]');
  });

  it('caps a huge error body', async () => {
    mockedAxios.post.mockRejectedValueOnce(httpError(500, 'x'.repeat(10_000)));
    expect((await failure()).message.length).toBeLessThan(1_000);
  });

  it.each(['ECONNABORTED', 'ETIMEDOUT'])(
    'a submit timeout (%s) is retryable',
    async (code) => {
      mockedAxios.post.mockRejectedValueOnce(noResponseError(code));

      const error = await failure();

      expect(error.retryable).toBe(true);
      expect(error.message).toContain('submit timed out');
    },
  );

  it('a network error is retryable', async () => {
    mockedAxios.post.mockRejectedValueOnce(noResponseError('ECONNRESET'));

    const error = await failure();

    expect(error.retryable).toBe(true);
    expect(error.message).toContain('submit network error (ECONNRESET)');
  });

  it('a submit response without polling_url is a retryable failure', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { id: 'job-3' } });

    const error = await failure();

    expect(error.retryable).toBe(true);
    expect(error.message).toContain('no polling_url in submit response');
  });

  it.each([
    ['Request Moderated', false],
    ['Content Moderated', true],
    ['Error', true],
    ['Task not found', true],
    ['SomethingNew', true],
  ])(
    'terminal status %s → retryable=%p, nothing downloaded',
    async (status, retryable) => {
      mockedAxios.post.mockResolvedValueOnce(submitted());
      mockedAxios.get.mockResolvedValueOnce({ data: { status } });

      const error = await failure();

      expect(error.retryable).toBe(retryable);
      expect(error.message).toContain(`job did not succeed (status=${status})`);
      expect(mockedAxios.get.mock.calls).toHaveLength(1);
    },
  );

  it('a Ready job without result.sample is a retryable failure', async () => {
    mockedAxios.post.mockResolvedValueOnce(submitted());
    mockedAxios.get.mockResolvedValueOnce({
      data: { status: 'Ready', result: null },
    });

    const error = await failure();

    expect(error.retryable).toBe(true);
    expect(error.message).toContain('Ready status without result.sample');
  });

  it('gives up, retryable, when the job is not Ready within the polling window', async () => {
    mockedAxios.post.mockResolvedValueOnce(submitted());
    mockedAxios.get.mockResolvedValue({ data: { status: 'Pending' } });

    const error = await failure();

    expect(error.retryable).toBe(true);
    expect(error.message).toContain(
      'job not Ready within 240000ms (last status=Pending)',
    );
    // Bounded: ~4 minutes of 1.5 s polls, then it stops — one submit only.
    const polls = mockedAxios.get.mock.calls.length;
    expect(polls).toBeGreaterThan(150);
    expect(polls).toBeLessThan(170);
    expect(mockedAxios.post.mock.calls).toHaveLength(1);
  });

  it('rides out transient poll errors without resubmitting (no second paid generation)', async () => {
    mockedAxios.post.mockResolvedValueOnce(submitted());
    mockedAxios.get
      .mockResolvedValueOnce({ data: { status: 'Pending' } })
      .mockRejectedValueOnce(httpError(502))
      .mockRejectedValueOnce(noResponseError('ECONNRESET'))
      .mockResolvedValueOnce(ready())
      .mockResolvedValueOnce({ data: Buffer.from('png') });

    const out = await enhance();

    expect(out.toString()).toBe('png');
    expect(mockedAxios.post.mock.calls).toHaveLength(1);
  });

  it('fails the attempt, retryable, after repeated poll errors in a row', async () => {
    mockedAxios.post.mockResolvedValueOnce(submitted());
    mockedAxios.get.mockRejectedValue(httpError(502));

    const error = await failure();

    expect(error.retryable).toBe(true);
    expect(error.message).toContain('poll HTTP 502');
    expect(mockedAxios.get.mock.calls).toHaveLength(3);
  });

  it('a poll rejected for the API key fails at once, not retryable', async () => {
    mockedAxios.post.mockResolvedValueOnce(submitted());
    mockedAxios.get.mockRejectedValueOnce(httpError(401));

    const error = await failure();

    expect(error.retryable).toBe(false);
    expect(error.message).toContain('poll HTTP 401');
    expect(mockedAxios.get.mock.calls).toHaveLength(1);
  });

  it('a failed result download is retryable (a new generation brings a fresh URL)', async () => {
    mockedAxios.post.mockResolvedValueOnce(submitted());
    mockedAxios.get
      .mockResolvedValueOnce(ready())
      .mockRejectedValueOnce(
        httpError(403, Buffer.from('<Error>Request has expired</Error>')),
      );

    const error = await failure();

    expect(error.retryable).toBe(true);
    expect(error.message).toContain(
      'download HTTP 403: <Error>Request has expired</Error>',
    );
    // The signed URL is not BFL's API: no misleading key hint.
    expect(error.message).not.toContain('BFL_API_KEY');
  });

  it('an empty result download is a retryable failure', async () => {
    mockedAxios.post.mockResolvedValueOnce(submitted());
    mockedAxios.get
      .mockResolvedValueOnce(ready())
      .mockResolvedValueOnce({ data: Buffer.alloc(0) });

    const error = await failure();

    expect(error.retryable).toBe(true);
    expect(error.message).toContain('downloaded result image is empty');
  });

  // BFL: "A failed task can come back as HTTP 503 with a normal JSON body. Read
  // status from the body before treating a 503 as a retryable outage." The poll
  // GET accepts 503, so real axios resolves it — and these mocks resolve it too.
  describe('HTTP 503 while polling', () => {
    const answer503 = (data: unknown) => ({ status: 503, data });

    it.each([
      ['Error', false],
      ['Request Moderated', false],
      ['Content Moderated', true],
      ['Task not found', true],
    ])(
      '503 + status %s ends polling at once (retryable=%p)',
      async (status, retryable) => {
        mockedAxios.post.mockResolvedValueOnce(submitted());
        mockedAxios.get.mockResolvedValueOnce(
          answer503({ id: 'job-1', status, details: { reason: 'boom' } }),
        );

        const error = await failure();

        expect(error.retryable).toBe(retryable);
        expect(error.message).toContain(
          `job did not succeed (status=${status}, HTTP 503: `,
        );
        expect(error.message).toContain('"details":{"reason":"boom"}');
        // No second poll, no download, no resubmit.
        expect(mockedAxios.get.mock.calls).toHaveLength(1);
        expect(mockedAxios.post.mock.calls).toHaveLength(1);
      },
    );

    it('503 without a task status keeps the transient behaviour: polled again, then a retryable failure', async () => {
      mockedAxios.post.mockResolvedValueOnce(submitted());
      mockedAxios.get.mockResolvedValue(
        answer503({ detail: 'Service Unavailable' }),
      );

      const error = await failure();

      expect(error.retryable).toBe(true);
      expect(error.message).toContain(
        'poll HTTP 503: {"detail":"Service Unavailable"}',
      );
      expect(mockedAxios.get.mock.calls).toHaveLength(3);
      expect(mockedAxios.post.mock.calls).toHaveLength(1);
    });

    it('a 503 outage (no body status, or not a BFL one) is ridden out, then Ready succeeds', async () => {
      mockedAxios.post.mockResolvedValueOnce(submitted());
      mockedAxios.get
        .mockResolvedValueOnce(
          answer503('<html>503 Service Unavailable</html>'),
        )
        .mockResolvedValueOnce(answer503({ status: 'Service Unavailable' }))
        .mockResolvedValueOnce(ready())
        .mockResolvedValueOnce({ data: Buffer.from('png') });

      const out = await enhance();

      expect(out.toString()).toBe('png');
      expect(mockedAxios.post.mock.calls).toHaveLength(1);
    });

    it('503 + a still-working status is read as that status: polling continues', async () => {
      mockedAxios.post.mockResolvedValueOnce(submitted());
      mockedAxios.get
        .mockResolvedValueOnce(answer503({ status: 'Pending' }))
        .mockResolvedValueOnce(ready())
        .mockResolvedValueOnce({ data: Buffer.from('png') });

      const out = await enhance();

      expect(out.toString()).toBe('png');
      expect(mockedAxios.get.mock.calls.map(([u]) => u)).toEqual([
        POLL,
        POLL,
        SAMPLE,
      ]);
    });

    it('normal polling is unchanged: 200 Pending → 200 Ready returns the PNG', async () => {
      mockedAxios.post.mockResolvedValueOnce(submitted());
      mockedAxios.get
        .mockResolvedValueOnce({ status: 200, data: { status: 'Pending' } })
        .mockResolvedValueOnce({ status: 200, ...ready() })
        .mockResolvedValueOnce({ status: 200, data: Buffer.from('png') });

      const out = await enhance();

      expect(out.toString()).toBe('png');
      expect(mockedAxios.get.mock.calls.map(([u]) => u)).toEqual([
        POLL,
        POLL,
        SAMPLE,
      ]);
      // The poll request's only change: a 503 now resolves (to be read)
      // instead of throwing; every other non-2xx still throws.
      const accepts = mockedAxios.get.mock.calls[0][1]?.validateStatus;
      expect([200, 204, 503].map((code) => accepts?.(code))).toEqual([
        true,
        true,
        true,
      ]);
      expect([401, 404, 429, 500, 502].map((code) => accepts?.(code))).toEqual([
        false,
        false,
        false,
        false,
        false,
      ]);
      // The result download keeps axios' default (2xx only).
      expect(mockedAxios.get.mock.calls[2][1]?.validateStatus).toBeUndefined();
    });
  });
});
