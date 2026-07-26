import type { NextFunction, Request, Response } from 'express';
import {
  REQUEST_ID_HEADER,
  generateRequestId,
  requestContext,
  sanitizeRequestId,
} from './request-context';

/**
 * Assigns every HTTP request a short correlation id and binds it to the async
 * context for the rest of that request.
 *
 * The id is:
 *   • taken from an inbound `X-Request-Id` when the caller supplied a usable one
 *     (so a correlation started upstream — Nginx, another service — is kept),
 *     otherwise generated;
 *   • echoed back in the `X-Request-Id` response header, so a client hitting an
 *     error can quote the exact id to support;
 *   • readable anywhere downstream via getRequestId(), with no plumbing.
 *
 * Registered as plain Express middleware in main.ts rather than a NestMiddleware
 * so it runs FIRST — before guards, pipes and any other middleware — and every
 * log line produced for the request, including rejections, can carry it.
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestId =
    sanitizeRequestId(req.headers[REQUEST_ID_HEADER]) ?? generateRequestId();

  // Expose it on the request too, for code holding a Request but not running
  // inside the ALS scope (e.g. an Express error handler).
  (req as Request & { requestId?: string }).requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);

  // `next()` is invoked INSIDE run(), so the entire downstream chain — including
  // everything awaited by the controller — shares this store.
  requestContext.run({ requestId }, () => next());
}
