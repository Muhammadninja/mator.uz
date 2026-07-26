import { Logger } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Constant-time credential comparison.
 *
 * `timingSafeEqual` throws on length mismatch and, worse, comparing raw
 * credentials leaks their length through timing. Hashing both sides to a
 * fixed-width digest first makes every comparison the same length, so neither
 * the value nor its length is observable. (Same approach as
 * BullBoardAuthMiddleware — kept local so this file has no cross-module
 * dependency and can run before the Nest container is involved.)
 */
function safeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

export interface SwaggerAuthCredentials {
  user: string;
  password: string;
}

/** Read the Swagger UI credentials from the environment. */
export function resolveSwaggerCredentials(
  env: NodeJS.ProcessEnv = process.env,
): SwaggerAuthCredentials {
  return {
    user: env.SWAGGER_USERNAME?.trim() ?? '',
    password: env.SWAGGER_PASSWORD ?? '',
  };
}

/**
 * HTTP Basic Auth in front of the Swagger UI, mirroring the protection already
 * applied to Bull Board (see ops/bull-board-auth.middleware.ts).
 *
 * Why Basic Auth rather than AdminJwtGuard: /docs is a server-rendered page
 * opened directly in a BROWSER. The app's authorization is a Bearer JWT that a
 * client attaches per request — a browser navigating to /docs sends no
 * Authorization header and there is no cookie session, so a JWT guard would put
 * the docs out of reach of the very people they exist for. Basic Auth is the
 * browser-native fit for this one non-API surface, with credentials distinct
 * from any admin account (SWAGGER_USERNAME / SWAGGER_PASSWORD).
 *
 * This is plain Express middleware rather than a NestMiddleware because
 * SwaggerModule.setup() registers its routes on the underlying Express
 * instance during bootstrap, before Nest's own middleware chain applies.
 *
 * FAIL-CLOSED: if credentials are not configured, EVERY request is refused. A
 * misconfiguration must never silently publish the full route and DTO map.
 */
export function createSwaggerAuthMiddleware(
  credentials: SwaggerAuthCredentials,
  logger: Logger,
): RequestHandler {
  const deny = (res: Response): void => {
    res.setHeader('WWW-Authenticate', 'Basic realm="API Documentation"');
    // Docs must never be cached by an intermediary.
    res.setHeader('Cache-Control', 'no-store');
    res.status(401).send('Unauthorized');
  };

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!credentials.user || !credentials.password) {
      logger.error(
        'Swagger is enabled but SWAGGER_USERNAME/SWAGGER_PASSWORD are unset — denying all access to /docs.',
      );
      deny(res);
      return;
    }

    const header = req.headers.authorization ?? '';
    const [scheme, encoded] = header.split(' ');
    if (scheme?.toLowerCase() !== 'basic' || !encoded) {
      deny(res);
      return;
    }

    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    // Split on the FIRST colon only: a password may legitimately contain colons.
    const separator = decoded.indexOf(':');
    if (separator === -1) {
      deny(res);
      return;
    }
    const user = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);

    // Both comparisons always run — no early return on a bad username — so the
    // response time doesn't reveal which half was wrong.
    const userOk = safeEqual(user, credentials.user);
    const passwordOk = safeEqual(password, credentials.password);
    if (!userOk || !passwordOk) {
      logger.warn(
        `Rejected Swagger docs access attempt from ${req.ip ?? 'unknown'}`,
      );
      deny(res);
      return;
    }

    next();
  };
}
