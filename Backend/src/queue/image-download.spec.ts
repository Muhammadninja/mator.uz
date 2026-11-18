// SEC-04: the image worker's downloader. Synthetic bodies only; the streaming
// limit is exercised against a local server with the real request config.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import axios from 'axios';
import {
  assertSafeImage,
  downloadImage,
  imageDimensions,
  ImageDownloadRejected,
  imageRequestConfig,
  imageUrlProblem,
  MAX_IMAGE_BYTES,
  MAX_REDIRECTS,
  sniffImage,
} from './image-download';

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function jpeg(width: number, height: number): Buffer {
  // SOI, an APP0 segment to skip, then SOF0 with the frame size.
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
    ...Array<number>(9).fill(0),
  ]);
}

function webpVp8x(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1');
  b.write('WEBP', 8, 'latin1');
  b.write('VP8X', 12, 'latin1');
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

describe('imageUrlProblem', () => {
  const prev = process.env.IMAGE_DOWNLOAD_ALLOWED_HOSTS;
  afterEach(() => {
    process.env.IMAGE_DOWNLOAD_ALLOWED_HOSTS = prev;
  });

  it.each([
    'https://api.telegram.org/file/botX/photos/a.jpg',
    'https://res.cloudinary.com/demo/image/upload/v1/a.jpg',
  ])('allows %s', (url) => expect(imageUrlProblem(url)).toBeNull());

  it.each([
    ['http://api.telegram.org/file/a.jpg', 'not https'],
    ['https://user:pw@res.cloudinary.com/a.jpg', 'credentials in URL'],
    ['https://res.cloudinary.com:8443/a.jpg', 'non-default port'],
    ['https://127.0.0.1/a.jpg', 'IP address host'],
    ['https://[::1]/a.jpg', 'IP address host'],
    ['https://169.254.169.254/latest/meta-data', 'IP address host'],
    ['https://evil.example/a.jpg', 'host not allowed'],
    ['https://res.cloudinary.com.evil.example/a.jpg', 'host not allowed'],
    ['file:///etc/passwd', 'not https'],
    ['not a url', 'not a URL'],
  ])('refuses %s (%s)', (url, reason) =>
    expect(imageUrlProblem(url)).toBe(reason),
  );

  it('honours IMAGE_DOWNLOAD_ALLOWED_HOSTS', () => {
    process.env.IMAGE_DOWNLOAD_ALLOWED_HOSTS = 'cdn.example.com';
    expect(imageUrlProblem('https://cdn.example.com/a.png')).toBeNull();
  });
});

describe('image signature and dimension checks', () => {
  it('sniffs JPEG, PNG and WebP and reads their dimensions', () => {
    expect(imageDimensions(png(640, 480), sniffImage(png(640, 480))!)).toEqual({
      width: 640,
      height: 480,
    });
    expect(
      imageDimensions(jpeg(1200, 900), sniffImage(jpeg(1200, 900))!),
    ).toEqual({ width: 1200, height: 900 });
    expect(
      imageDimensions(webpVp8x(800, 600), sniffImage(webpVp8x(800, 600))!),
    ).toEqual({ width: 800, height: 600 });
  });

  it('accepts ordinary photos', () => {
    expect(() => assertSafeImage(jpeg(4032, 3024))).not.toThrow();
    expect(() => assertSafeImage(png(1024, 1024))).not.toThrow();
  });

  it.each([
    ['empty', Buffer.alloc(0)],
    ['HTML error page', Buffer.from('<html>502 Bad Gateway</html>')],
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['gzip', Buffer.from([0x1f, 0x8b, 0x08, 0x00])],
    ['truncated JPEG', jpeg(100, 100).subarray(0, 12)],
    ['truncated PNG', png(100, 100).subarray(0, 16)],
    ['zero-size PNG', png(0, 100)],
    ['PNG pixel bomb', png(100_000, 100_000)],
    ['JPEG pixel bomb', jpeg(65_000, 65_000)],
    ['WebP pixel bomb', webpVp8x(16_000, 16_000)],
  ])('rejects %s', (_label, body) => {
    expect(() => assertSafeImage(body)).toThrow(ImageDownloadRejected);
  });
});

describe('downloadImage', () => {
  afterEach(() => jest.restoreAllMocks());

  it('never makes a request for a refused URL', async () => {
    const get = jest.spyOn(axios, 'get');
    await expect(downloadImage('https://10.0.0.5/a.jpg')).rejects.toThrow(
      ImageDownloadRejected,
    );
    await expect(downloadImage('https://internal.svc/a.jpg')).rejects.toThrow(
      ImageDownloadRejected,
    );
    expect(get).not.toHaveBeenCalled();
  });

  it('sends the bounded request config and returns a valid image', async () => {
    const body = jpeg(800, 600);
    const get = jest.spyOn(axios, 'get').mockResolvedValue({
      data: body,
      headers: { 'content-type': 'image/jpeg' },
    });
    await expect(
      downloadImage('https://res.cloudinary.com/demo/image/upload/a.jpg'),
    ).resolves.toEqual(body);
    const config = get.mock.calls[0][1]!;
    expect(config.maxContentLength).toBe(MAX_IMAGE_BYTES);
    expect(config.maxRedirects).toBe(MAX_REDIRECTS);
    expect(config.timeout).toBeGreaterThan(0);
    expect(config.signal).toBeDefined();
    expect(config.proxy).toBe(false);
    expect(config.httpsAgent).toBeDefined();
  });

  it("accepts Telegram's octet-stream content type when the bytes are an image", async () => {
    jest.spyOn(axios, 'get').mockResolvedValue({
      data: jpeg(1280, 960),
      headers: { 'content-type': 'application/octet-stream' },
    });
    await expect(
      downloadImage('https://api.telegram.org/file/botX/a.jpg'),
    ).resolves.toBeInstanceOf(Buffer);
  });

  it.each([
    ['text/html', Buffer.from('<html></html>')],
    ['image/svg+xml', Buffer.from('<svg/>')],
    ['image/jpeg', Buffer.from('not really a jpeg')],
  ])('rejects a %s body', async (type, data) => {
    jest
      .spyOn(axios, 'get')
      .mockResolvedValue({ data, headers: { 'content-type': type } });
    await expect(
      downloadImage('https://res.cloudinary.com/demo/image/upload/a.jpg'),
    ).rejects.toThrow(ImageDownloadRejected);
  });

  it('refuses redirect hops off the allowlist or off https', () => {
    const before = imageRequestConfig().beforeRedirect!;
    const hop = (href: string) => () =>
      before({ href } as never, { headers: {}, statusCode: 302 }, {} as never);
    expect(hop('https://169.254.169.254/latest/meta-data')).toThrow(
      ImageDownloadRejected,
    );
    expect(hop('http://res.cloudinary.com/demo/image/upload/a.jpg')).toThrow(
      ImageDownloadRejected,
    );
    expect(hop('https://evil.example/a.jpg')).toThrow(ImageDownloadRejected);
    expect(hop('https://res.cloudinary.com/demo/image/upload/b.jpg')).not.toThrow();
  });
});

describe('streaming byte ceiling (real transfer, local server)', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/huge') {
        // No Content-Length: the limit must hold while streaming.
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        const chunk = Buffer.alloc(1024 * 1024);
        let sent = 0;
        const pump = () => {
          while (sent < 64 && res.write(chunk)) sent += 1;
          if (sent < 64 && !res.destroyed) res.once('drain', pump);
          else res.end();
        };
        pump();
      } else if (req.url === '/truncated') {
        res.writeHead(200, {
          'content-type': 'image/jpeg',
          'content-length': '100000',
        });
        res.write(Buffer.alloc(10));
        res.destroy();
      } else {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(png(10, 10));
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  // Same limits as production, minus the public-only https agent (the test
  // server is local by necessity).
  const config = () => ({ ...imageRequestConfig(), httpsAgent: undefined });

  it('aborts a response that exceeds MAX_IMAGE_BYTES mid-stream', async () => {
    await expect(axios.get(`${base}/huge`, config())).rejects.toThrow(
      /maxContentLength/,
    );
  });

  it('fails a truncated response', async () => {
    await expect(axios.get(`${base}/truncated`, config())).rejects.toThrow();
  });

  it('downloads a small image under the same config', async () => {
    const res = await axios.get<ArrayBuffer>(`${base}/ok`, config());
    expect(() => assertSafeImage(Buffer.from(res.data))).not.toThrow();
  });
});
