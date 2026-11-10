import type { NextFunction, Request, Response } from 'express';

/** Route whose body must survive as raw text — the Payme Merchant API webhook. */
export const PAYME_WEBHOOK_PATH = '/v1/payments/payme/webhook';

/**
 * Largest body accepted. A Merchant API call is a small JSON-RPC envelope; the
 * largest, SetFiscalData, carries a receipt reference and a QR-code URL and
 * stays well under a few kilobytes. 64 KB leaves a wide margin and bounds what
 * an unauthenticated caller can make this process buffer per request.
 */
export const PAYME_MAX_BODY_BYTES = 64 * 1024;

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
 * The one exception is a body over {@link PAYME_MAX_BODY_BYTES}: that is not a
 * Merchant API call, and it is answered 413 without being buffered or handed to
 * the service. A declared Content-Length over the limit is refused before a
 * single byte is read.
 *
 * Registered for the Payme path only, so `req.body` stays a parsed object
 * everywhere else. Setting `req.body` also makes the downstream JSON parser a
 * no-op for this request.
 */
export function paymeRawBodyMiddleware(
  req: Request,
  res: Response,
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

  const tooLarge = () => {
    if (settled) return;
    settled = true;
    chunks.length = 0;
    // Stop reading: the rest of the body is discarded, not buffered.
    req.removeAllListeners('data');
    req.resume();
    res.setHeader('Connection', 'close');
    res
      .status(413)
      .json({ code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' });
  };

  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > PAYME_MAX_BODY_BYTES) {
    return tooLarge();
  }

  req.on('data', (chunk: Buffer) => {
    if (settled) return;
    size += chunk.length;
    if (size > PAYME_MAX_BODY_BYTES) return tooLarge();
    chunks.push(chunk);
  });
  req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
  req.on('error', () => finish(''));
}
