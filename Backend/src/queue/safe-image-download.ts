import axios from 'axios';
import { Agent } from 'node:https';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { publicOnlyLookup } from '../ai/bfl-url-policy';

export const IMAGE_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_DOWNLOAD_MAX_PIXELS = 16_000_000;
const TOTAL_MS = 20_000;
const SOCKET_MS = 5_000;
// Bound simultaneous buffers and decoded surfaces, independently of BullMQ settings.
const MAX_ACTIVE = 2;
let active = 0;
const agent = new Agent({ lookup: publicOnlyLookup, maxSockets: MAX_ACTIVE, keepAlive: false });

export function assertImageSource(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Image source URL refused'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) {
    throw new Error('Image source URL refused');
  }
  // No arbitrary URL, port, credential forwarding or redirect support. Telegram
  // links contain the bot token: errors must never include the supplied URL.
  const telegram = url.hostname === 'api.telegram.org' && /^\/file\/bot[^/]+\//.test(url.pathname);
  const cloudinary = url.hostname === 'res.cloudinary.com' && /^\/[^/]+\/image\/upload\//.test(url.pathname);
  if (!telegram && !cloudinary) throw new Error('Image source host/path refused');
  return url;
}

export async function readImageStream(stream: Readable, maxBytes = IMAGE_DOWNLOAD_MAX_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) throw new Error('Image response exceeds byte limit');
      chunks.push(bytes);
    }
    if (!size) throw new Error('Image response is empty');
    return Buffer.concat(chunks, size);
  } catch (error) {
    stream.destroy();
    throw error;
  }
}

export async function validateRaster(bytes: Buffer, contentType: string): Promise<void> {
  const type = contentType.split(';')[0].trim().toLowerCase();
  let format: 'png' | 'jpeg' | 'webp' | undefined;
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) format = 'png';
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) format = 'jpeg';
  else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') format = 'webp';
  if (!format || ![`image/${format}`, 'application/octet-stream'].includes(type)) {
    throw new Error('Image content type/signature refused');
  }
  // Decoding is required: metadata alone accepts truncated/malformed payloads.
  // This worker never accepts SVG, animated images, or unbounded pixel surfaces.
  const decoder = sharp(bytes, { failOn: 'warning', limitInputPixels: IMAGE_DOWNLOAD_MAX_PIXELS, sequentialRead: true });
  const meta = await decoder.metadata();
  if (meta.format !== format || !meta.width || !meta.height || meta.width * meta.height > IMAGE_DOWNLOAD_MAX_PIXELS || (meta.pages ?? 1) !== 1) {
    throw new Error('Image dimensions/animation refused');
  }
  await decoder.timeout({ seconds: 5 }).stats();
}

export async function downloadSourceImage(raw: string): Promise<Buffer> {
  assertImageSource(raw);
  if (active >= MAX_ACTIVE) throw new Error('Image download capacity reached; retry later');
  active += 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOTAL_MS);
  let stream: Readable | undefined;
  try {
    const response = await axios.get<Readable>(raw, {
      responseType: 'stream', maxRedirects: 0, proxy: false,
      httpsAgent: agent, timeout: SOCKET_MS, signal: controller.signal,
      decompress: false, headers: { 'Accept-Encoding': 'identity' },
      maxContentLength: IMAGE_DOWNLOAD_MAX_BYTES, maxBodyLength: IMAGE_DOWNLOAD_MAX_BYTES,
      validateStatus: (status) => status === 200,
    });
    stream = response.data;
    const encoding = response.headers['content-encoding'];
    if (encoding && encoding !== 'identity') throw new Error('Compressed image transport refused');
    const length = response.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > IMAGE_DOWNLOAD_MAX_BYTES)) {
      throw new Error('Image response length refused');
    }
    const bytes = await readImageStream(stream);
    if (length !== undefined && bytes.length !== Number(length)) throw new Error('Truncated image response');
    await validateRaster(bytes, String(response.headers['content-type'] ?? ''));
    return bytes;
  } catch {
    // axios errors contain request paths, including Telegram credentials.
    throw new Error('Image download or validation failed');
  } finally {
    clearTimeout(timer);
    stream?.destroy();
    active -= 1;
  }
}
