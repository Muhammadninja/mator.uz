import type { NextFunction, Request, Response } from 'express';
import { MAX_SYNC_ITEMS } from './dto/sync-inventory.dto';

export const SYNC_INVENTORY_PATH = '/v1/integrations/dealers/sync-inventory';

/**
 * The largest valid row, as encoded: the field names and numbers take about 100
 * bytes, and the 399 characters the DTO allows in its strings take at most 6 bytes
 * each when an exporter escapes them as \uXXXX, so 2,500 bytes covers one row.
 */
const MAX_ROW_BYTES = 2_500;
const ENVELOPE_BYTES = 1_024;
const DRAIN_MS = 5_000;

/** Holds every valid {@link MAX_SYNC_ITEMS}-row upload, however it is encoded. */
export const MAX_SYNC_BODY_BYTES =
  MAX_SYNC_ITEMS * MAX_ROW_BYTES + ENVELOPE_BYTES;

function refuse(
  req: Request,
  res: Response,
  status: number,
  code: string,
  message: string,
): void {
  res.status(status).json({ code, message });
  // Discard what is still arriving, so the sender can read this answer, but do
  // not wait on it for ever.
  req.resume();
  setTimeout(() => req.destroy(), DRAIN_MS).unref();
}

/**
 * Parse this route's JSON body under its own limit, in the same way the Payme
 * webhook is taken over before the global parser: a set `req.body` makes that
 * parser a no-op for this request. Oversized and malformed bodies get a 4xx in the
 * API's `{ code, message }` shape before any handler runs.
 *
 * A compressed or non-JSON body is left to the global parser, unchanged.
 */
export function syncInventoryBodyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (
    req.method !== 'POST' ||
    req.headers['content-encoding'] ||
    !req.headers['content-type']?.toLowerCase().includes('json')
  ) {
    return next();
  }
  const tooLarge = () =>
    refuse(
      req,
      res,
      413,
      'PAYLOAD_TOO_LARGE',
      `The upload is larger than ${MAX_SYNC_BODY_BYTES} bytes.`,
    );
  if (Number(req.headers['content-length']) > MAX_SYNC_BODY_BYTES) {
    return tooLarge();
  }

  let size = 0;
  let settled = false;
  const chunks: Buffer[] = [];

  req.on('data', (chunk: Buffer) => {
    if (settled) return;
    size += chunk.length;
    if (size > MAX_SYNC_BODY_BYTES) {
      settled = true;
      chunks.length = 0;
      tooLarge();
      return;
    }
    chunks.push(chunk);
  });
  req.on('error', (err) => {
    if (settled) return;
    settled = true;
    next(err);
  });
  req.on('end', () => {
    if (settled) return;
    settled = true;
    const text = Buffer.concat(chunks).toString('utf8');
    let body: unknown = {};
    try {
      if (text.trim()) body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (typeof body !== 'object' || body === null) {
      refuse(req, res, 400, 'INVALID_JSON', 'The body is not valid JSON.');
      return;
    }
    req.body = body;
    next();
  });
}
