// Tests for the ImageEnhanceService (FLUX.2 Max): submit the base64 image with
// the preservation prompt, width=height=1000, and output_format=png; poll the
// returned polling_url until Ready; then download the signed result URL and
// return that PNG buffer (a 1000×1000 product photo on a white background).
// All HTTP calls (axios.post / axios.get) are mocked — no network happens.

import axios from 'axios';
import { ImageEnhanceService } from './image-enhance.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const OLD_ENV = process.env;

beforeEach(() => {
  jest.resetAllMocks();
  // removeBackground's error path uses axios.isAxiosError; keep the real one.
  (mockedAxios.isAxiosError as unknown) = jest.requireActual('axios').isAxiosError;
  process.env = { ...OLD_ENV, BFL_API_KEY: 'test-key' };
});

afterAll(() => {
  process.env = OLD_ENV;
});

describe('ImageEnhanceService.removeBackground', () => {
  it('throws when BFL_API_KEY is missing', () => {
    delete process.env.BFL_API_KEY;
    expect(() => new ImageEnhanceService()).toThrow('BFL_API_KEY is not set');
  });

  it('submits the base64 image, polls until Ready, and returns the downloaded PNG', async () => {
    const source = Buffer.from('source-jpeg');
    const png = Buffer.from('WHITE_BG_PNG_BYTES');

    mockedAxios.post.mockResolvedValue({ data: { id: 'job-1', polling_url: 'https://poll/job-1' } });
    // First poll still Pending, second poll Ready — proves it actually polls.
    mockedAxios.get
      .mockResolvedValueOnce({ data: { status: 'Pending' } })
      .mockResolvedValueOnce({ data: { status: 'Ready', result: { sample: 'https://cdn/out.png' } } })
      .mockResolvedValueOnce({ data: png }); // the image download

    const svc = new ImageEnhanceService();
    const out = await svc.removeBackground(source);

    // Returned byte-for-byte, no post-processing.
    expect(out.equals(png)).toBe(true);

    // Submit: FLUX.2 Max endpoint, base64 body, 1000×1000, png output, x-key auth.
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    const [url, body, cfg] = mockedAxios.post.mock.calls[0];
    expect(url).toBe('https://api.bfl.ai/v1/flux-2-max');
    const payload = body as {
      prompt: string;
      input_image: string;
      width: number;
      height: number;
      output_format: string;
    };
    expect(payload.input_image).toBe(source.toString('base64'));
    expect(payload.width).toBe(1000);
    expect(payload.height).toBe(1000);
    expect(payload.output_format).toBe('png');
    expect(payload.prompt).toContain('pure white (#FFFFFF) background');
    // Text/logo protection is the point of this prompt — assert its guardrails.
    expect(payload.prompt).toContain('KEEP IT BLURRY');
    expect(payload.prompt).toContain('Never reconstruct letters');
    expect(payload.prompt).toContain('Treat the input image as the ground truth');
    expect(payload.prompt).toContain('TEXT IS EVIDENCE');
    expect(payload.prompt).toContain('Incorrect text is worse than blurry text');
    expect(payload.prompt).toContain('documentary photograph of the original object');
    expect(payload.prompt).toContain('Accuracy has absolute priority over aesthetics');
    // Object is immutable — only background pixels may change.
    expect(payload.prompt).toContain('OBJECT INTEGRITY');
    expect(payload.prompt).toContain('Replace only the background');
    expect(payload.prompt).toContain('Only pixels that belong to the background may be modified');
    expect(payload.prompt).toContain(
      'The ideal output is indistinguishable from the original photograph',
    );
    // "sharpness" was deliberately removed so the model does not read it as
    // license to reconstruct local detail — guard against it creeping back.
    expect(payload.prompt).not.toContain('sharpness');
    expect((cfg as { headers: Record<string, string> }).headers['x-key']).toBe('test-key');

    // Polled the returned polling_url, then downloaded the signed sample URL.
    expect(mockedAxios.get).toHaveBeenCalledTimes(3);
    expect(mockedAxios.get.mock.calls[0][0]).toBe('https://poll/job-1');
    expect(mockedAxios.get.mock.calls[1][0]).toBe('https://poll/job-1');
    expect(mockedAxios.get.mock.calls[2][0]).toBe('https://cdn/out.png');
    expect((mockedAxios.get.mock.calls[2][1] as { responseType?: string }).responseType).toBe(
      'arraybuffer',
    );
  });

  it('throws with the HTTP detail on a FLUX submit error response', async () => {
    const err = Object.assign(new Error('Request failed'), {
      isAxiosError: true,
      response: { status: 402, data: Buffer.from('Payment required') },
    });
    mockedAxios.post.mockRejectedValue(err);

    const svc = new ImageEnhanceService();
    await expect(svc.removeBackground(Buffer.from('x'))).rejects.toThrow(
      /FLUX\.2 Max edit failed — HTTP 402: Payment required/,
    );
  });

  it('throws when the job reaches a terminal non-Ready status', async () => {
    mockedAxios.post.mockResolvedValue({ data: { polling_url: 'https://poll/job-2' } });
    mockedAxios.get.mockResolvedValue({ data: { status: 'Content Moderated' } });

    const svc = new ImageEnhanceService();
    await expect(svc.removeBackground(Buffer.from('x'))).rejects.toThrow(
      /FLUX\.2 Max edit failed — job did not succeed \(status=Content Moderated\)/,
    );
    // No download attempted on failure.
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it('throws when the submit response has no polling_url', async () => {
    mockedAxios.post.mockResolvedValue({ data: { id: 'job-3' } });

    const svc = new ImageEnhanceService();
    await expect(svc.removeBackground(Buffer.from('x'))).rejects.toThrow(/no polling_url/);
  });
});
