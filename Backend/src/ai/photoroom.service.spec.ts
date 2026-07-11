// Tests for the PhotoroomService: one /v2/edit call (removeBackground +
// beautify.mode=ai.car → PNG), returning the transparent PNG unchanged. The
// single HTTP call (axios.post) is mocked — no network happens.

import axios from 'axios';
import FormData from 'form-data';
import { PhotoroomService } from './photoroom.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const OLD_ENV = process.env;

beforeEach(() => {
  jest.resetAllMocks();
  // removeBackground's error path uses axios.isAxiosError; keep the real one.
  (mockedAxios.isAxiosError as unknown) = jest.requireActual('axios').isAxiosError;
  process.env = { ...OLD_ENV, PHOTOROOM_API_KEY: 'test-key' };
});

afterAll(() => {
  process.env = OLD_ENV;
});

/** Read a submitted FormData back into a plain field map for assertions. */
function formFields(form: FormData): Record<string, string> {
  const buf = form.getBuffer().toString('latin1');
  const fields: Record<string, string> = {};
  const re = /name="([^"]+)"(?:; filename="[^"]*")?\r\n(?:Content-Type: [^\r\n]+\r\n)?\r\n([\s\S]*?)\r\n--/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buf)) !== null) fields[m[1]] = m[2];
  return fields;
}

describe('PhotoroomService.removeBackground', () => {
  it('throws when PHOTOROOM_API_KEY is missing', () => {
    delete process.env.PHOTOROOM_API_KEY;
    expect(() => new PhotoroomService()).toThrow('PHOTOROOM_API_KEY is not set');
  });

  it('sends a single remove-background + AI Car edit call and returns the PNG unchanged', async () => {
    const png = Buffer.from('TRANSPARENT_PNG_BYTES');
    mockedAxios.post.mockResolvedValue({ data: png });

    const svc = new PhotoroomService();
    const out = await svc.removeBackground(Buffer.from('source-jpeg'));

    // Returned byte-for-byte, no post-processing.
    expect(out.equals(png)).toBe(true);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);

    const [url, form, cfg] = mockedAxios.post.mock.calls[0];
    expect(url).toBe('https://image-api.photoroom.com/v2/edit');
    const fields = formFields(form as FormData);
    expect(fields.removeBackground).toBe('true');
    expect(fields['beautify.mode']).toBe('ai.car');
    expect(fields['export.format']).toBe('png');
    expect(fields['upscale.mode']).toBeUndefined(); // no AI Upscale
    expect((cfg as { responseType?: string }).responseType).toBe('arraybuffer');
    expect((cfg as { headers: Record<string, string> }).headers['x-api-key']).toBe('test-key');
  });

  it('throws with the HTTP detail on a PhotoRoom error response', async () => {
    const err = Object.assign(new Error('Request failed'), {
      isAxiosError: true,
      response: { status: 402, data: Buffer.from('Payment required') },
    });
    mockedAxios.post.mockRejectedValue(err);

    const svc = new PhotoroomService();
    await expect(svc.removeBackground(Buffer.from('x'))).rejects.toThrow(
      /AI Car edit failed — HTTP 402: Payment required/,
    );
  });
});
