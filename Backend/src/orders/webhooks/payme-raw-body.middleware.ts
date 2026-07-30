import type { NextFunction, Request, Response } from 'express';

/** Route whose body must survive as raw text — the Payme Merchant API webhook. */
export const PAYME_WEBHOOK_PATH = '/v1/payments/payme/webhook';

/** Payme never sends bodies anywhere near this size; cap to bound memory. */
const MAX_BODY_BYTES = 1_000_000;

/**
 * Buffer the Payme webhook body as a raw string instead of letting the global
 * JSON parser handle it.
 *
 * The Merchant API requires HTTP 200 with a JSON-RPC error for every failure,
 * including a malformed payload (-32700). Express's `json()` parser instead
 * rejects a syntax error with HTTP 400 before any handler runs, and Payme reads
 * a non-200 as -32400. Collecting the text here lets {@link PaymeService}
 * attempt the parse and answer -32700 in a 200 response.
 *
 * Registered for the Payme path only, so `req.body` stays a parsed object
 * everywhere else. Setting `req.body` also makes the downstream JSON parser a
 * no-op for this request.
 */
export function paymeRawBodyMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (req.method !== 'POST') return next();

  let size = 0;
  const chunks: Buffer[] = [];
  let settled = false;

  const finish = (body: string) => {
    if (settled) return;
    settled = true;
    // A string body is passed through by express.json() untouched, so the raw
    // text reaches the controller intact.
    req.body = body;
    next();
  };

  req.on('data', (chunk: Buffer) => {
    if (settled) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      chunks.length = 0;
      // Hand PaymeService something it will fail to parse → -32700, rather than
      // buffering an unbounded payload.
      finish('');
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
  req.on('error', () => finish(''));
}
