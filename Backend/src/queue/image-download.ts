import axios, { type AxiosRequestConfig } from 'axios';
import { isIP } from 'node:net';
import { providerUrlAgent } from '../ai/bfl-url-policy';

/**
 * Bounded download of a draft image for the image worker (SEC-04).
 *
 * The worker fetches two kinds of URL: the Telegram file link for a seller's
 * photo, and the Cloudinary original it stored itself. Neither is a URL a
 * customer can choose, but both are still fetched under one strict policy:
 *
 *   • https only, no credentials, default port, no IP-literal host;
 *   • the host must be Telegram's file API or Cloudinary's delivery host (or a
 *     host listed in IMAGE_DOWNLOAD_ALLOWED_HOSTS), checked again on every
 *     redirect hop, with at most {@link MAX_REDIRECTS} hops;
 *   • every connection resolves through the public-only lookup, so a name that
 *     resolves to loopback/private/link-local addresses is refused;
 *   • axios aborts the transfer once more than {@link MAX_IMAGE_BYTES} decoded
 *     bytes arrive (a gzip body is counted after decompression);
 *   • a connection/idle timeout plus a hard total deadline;
 *   • the body must be a JPEG, PNG or WebP by its signature, with readable
 *     dimensions under {@link MAX_IMAGE_PIXELS}, so a hostile file cannot
 *     reach Cloudinary or FLUX as a decompression bomb.
 *
 * Memory stays bounded by worker concurrency × MAX_IMAGE_BYTES.
 */

/** Telegram's Bot API serves files up to 20 MB; nothing larger is legitimate. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** ~50 megapixels: far above any phone photo, far below a pixel bomb. */
export const MAX_IMAGE_PIXELS = 50_000_000;
export const MAX_REDIRECTS = 2;
const CONNECT_TIMEOUT_MS = 20_000;
const TOTAL_TIMEOUT_MS = 45_000;

const DEFAULT_HOSTS = ['api.telegram.org', 'res.cloudinary.com'];

/** The download was refused or failed a check that a retry cannot fix. */
export class ImageDownloadRejected extends Error {
  constructor(message: string) {
    super(`image download refused: ${message}`);
    this.name = 'ImageDownloadRejected';
  }
}

function allowedHosts(): string[] {
  const extra = (process.env.IMAGE_DOWNLOAD_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return [...DEFAULT_HOSTS, ...extra];
}

/** Why `raw` may not be fetched, or null when it may. */
export function imageUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a URL';
  }
  if (url.protocol !== 'https:') return 'not https';
  if (url.username || url.password) return 'credentials in URL';
  if (url.port !== '') return 'non-default port';
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0) return 'IP address host';
  return allowedHosts().includes(host) ? null : 'host not allowed';
}

type ImageKind = 'jpeg' | 'png' | 'webp';

export function sniffImage(buf: Buffer): ImageKind | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return 'jpeg';
  if (
    buf.length >= 8 &&
    buf
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'png';
  if (
    buf.length >= 12 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  )
    return 'webp';
  return null;
}

/** Width/height from the image header, or null when it cannot be read. */
export function imageDimensions(
  buf: Buffer,
  kind: ImageKind,
): { width: number; height: number } | null {
  if (kind === 'png') {
    if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR')
      return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (kind === 'webp') {
    if (buf.length < 30) return null;
    const chunk = buf.toString('latin1', 12, 16);
    if (chunk === 'VP8X')
      return {
        width: 1 + buf.readUIntLE(24, 3),
        height: 1 + buf.readUIntLE(27, 3),
      };
    if (chunk === 'VP8 ')
      return {
        width: buf.readUInt16LE(26) & 0x3fff,
        height: buf.readUInt16LE(28) & 0x3fff,
      };
    if (chunk === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
    return null;
  }
  // JPEG: walk the marker segments to the first start-of-frame.
  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) return null;
    const marker = buf[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      offset += 2;
      continue;
    }
    const length = buf.readUInt16BE(offset + 2);
    if (length < 2) return null;
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSof) {
      if (offset + 9 > buf.length) return null;
      return {
        height: buf.readUInt16BE(offset + 5),
        width: buf.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return null;
}

/** Validates a downloaded body; throws ImageDownloadRejected when unsafe. */
export function assertSafeImage(buf: Buffer): void {
  if (buf.length === 0) throw new ImageDownloadRejected('empty body');
  const kind = sniffImage(buf);
  if (!kind) throw new ImageDownloadRejected('not a JPEG, PNG or WebP image');
  const size = imageDimensions(buf, kind);
  if (!size || size.width === 0 || size.height === 0) {
    throw new ImageDownloadRejected(`unreadable ${kind} dimensions`);
  }
  if (size.width * size.height > MAX_IMAGE_PIXELS) {
    throw new ImageDownloadRejected(
      `${size.width}x${size.height} exceeds the pixel limit`,
    );
  }
}

const ALLOWED_TYPES =
  /^(image\/(jpeg|png|webp)|application\/octet-stream|binary\/octet-stream)\s*(;|$)/i;

/** Request limits shared by every image download (exported for tests). */
export function imageRequestConfig(): AxiosRequestConfig {
  return {
    responseType: 'arraybuffer',
    timeout: CONNECT_TIMEOUT_MS,
    signal: AbortSignal.timeout(TOTAL_TIMEOUT_MS),
    maxContentLength: MAX_IMAGE_BYTES,
    maxBodyLength: MAX_IMAGE_BYTES,
    maxRedirects: MAX_REDIRECTS,
    httpsAgent: providerUrlAgent,
    proxy: false,
    // Each redirect hop is held to the same rule as the first URL.
    beforeRedirect: (options: {
      protocol?: string;
      hostname?: string;
      href?: string;
    }) => {
      const next =
        options.href ?? `${options.protocol ?? ''}//${options.hostname ?? ''}/`;
      const hop = imageUrlProblem(next);
      if (hop) throw new ImageDownloadRejected(`redirect ${hop}`);
    },
  };
}

export async function downloadImage(url: string): Promise<Buffer> {
  const problem = imageUrlProblem(url);
  if (problem) throw new ImageDownloadRejected(problem);
  const response = await axios.get<ArrayBuffer>(url, imageRequestConfig());
  const type = String(
    response.headers?.['content-type'] ?? 'application/octet-stream',
  );
  if (!ALLOWED_TYPES.test(type))
    throw new ImageDownloadRejected(`content-type ${type}`);
  const buf = Buffer.from(response.data);
  if (buf.length > MAX_IMAGE_BYTES)
    throw new ImageDownloadRejected('body exceeds the limit');
  assertSafeImage(buf);
  return buf;
}
