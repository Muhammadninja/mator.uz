import axios from 'axios';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { assertImageSource, downloadSourceImage, readImageStream, validateRaster, IMAGE_DOWNLOAD_MAX_BYTES } from './safe-image-download';
import { isPublicAddress } from '../ai/bfl-url-policy';

jest.mock('axios');
const get = jest.mocked(axios.get);
const SOURCE = 'https://res.cloudinary.com/test/image/upload/sample.png';
let png: Buffer;
beforeAll(async () => { png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).png().toBuffer(); });
beforeEach(() => jest.clearAllMocks());
function response(body: Buffer = png, headers: Record<string, string> = {}) {
  return { data: Readable.from([body]), headers: { 'content-type': 'image/png', ...headers } };
}

describe('source image security', () => {
  it.each(['http://api.telegram.org/file/botsecret/x', 'https://evil.example/x', 'https://res.cloudinary.com.evil.example/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://user:secret@res.cloudinary.com/test/image/upload/x', 'https://res.cloudinary.com:444/test/image/upload/x', 'https://res.cloudinary.com/test/raw/upload/x'])('refuses untrusted source %s', (url) => expect(() => assertImageSource(url)).toThrow());
  it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '::ffff:7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::', 'fe80::1'])('refuses non-public DNS destination %s', (ip) => expect(isPublicAddress(ip)).toBe(false));
  it('streams valid raster and configures connection policy without proxies or redirects', async () => {
    get.mockResolvedValue(response());
    expect(await downloadSourceImage(SOURCE)).toEqual(png);
    expect(get).toHaveBeenCalledWith(SOURCE, expect.objectContaining({ responseType: 'stream', maxRedirects: 0, proxy: false, decompress: false, timeout: 5000, signal: expect.any(AbortSignal) }));
  });
  it('enforces a byte limit on chunked responses without trusting content length', async () => {
    const stream = Readable.from([Buffer.alloc(6), Buffer.alloc(6)]);
    await expect(readImageStream(stream, 10)).rejects.toThrow('byte limit');
    expect(stream.destroyed).toBe(true);
  });
  it.each<Record<string, string>>([
    { 'content-length': String(IMAGE_DOWNLOAD_MAX_BYTES + 1) },
    { 'content-length': 'not-a-number' },
    { 'content-length': '1' },
    { 'content-encoding': 'gzip' },
    { 'content-type': 'image/jpeg' },
    { 'content-type': 'text/html' },
  ])('refuses invalid headers %j', async (headers) => {
    const res = response(png, headers); get.mockResolvedValue(res);
    await expect(downloadSourceImage(SOURCE)).rejects.toThrow('validation failed');
    expect(res.data.destroyed).toBe(true);
  });
  it('refuses truncated and malformed raster', async () => {
    await expect(validateRaster(png.subarray(0, 40), 'image/png')).rejects.toThrow();
    await expect(validateRaster(Buffer.from('<svg/>'), 'image/svg+xml')).rejects.toThrow();
  });
  it('refuses huge dimensions before full decode', async () => {
    const bomb = Buffer.from(png); bomb.writeUInt32BE(100000, 16); bomb.writeUInt32BE(100000, 20);
    await expect(validateRaster(bomb, 'image/png')).rejects.toThrow();
  });
  it('never exposes credential-bearing request details in errors', async () => {
    get.mockRejectedValue(new Error('https://api.telegram.org/file/botSECRET/x'));
    await expect(downloadSourceImage('https://api.telegram.org/file/botSECRET/x')).rejects.toThrow(/^Image download or validation failed$/);
  });
  it('caps concurrent downloads independently of worker settings', async () => {
    const streams = [new Readable({ read() {} }), new Readable({ read() {} })];
    get.mockResolvedValueOnce({ data: streams[0], headers: { 'content-type': 'image/png' } }).mockResolvedValueOnce({ data: streams[1], headers: { 'content-type': 'image/png' } });
    const first = downloadSourceImage(SOURCE); const second = downloadSourceImage(SOURCE);
    await expect(downloadSourceImage(SOURCE)).rejects.toThrow('capacity');
    streams.forEach((s) => { s.push(png); s.push(null); });
    await Promise.all([first, second]);
  });
});
