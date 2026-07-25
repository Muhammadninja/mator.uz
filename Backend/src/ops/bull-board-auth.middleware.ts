import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { resolveBullBoardConfig, type BullBoardConfig } from './ops.config';

/**
 * Constant-time credential comparison.
 *
 * `timingSafeEqual` throws on length mismatch and, worse, comparing raw
 * credentials leaks their length through timing. Hashing both sides to a
 * fixed-width digest first makes every comparison the same length, so neither
 * the value nor its length is observable.
 */
function safeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * HTTP Basic Auth in front of Bull Board.
 *
 * Why Basic Auth rather than the app's JwtAuthGuard + @Roles('ADMIN'):
 * Bull Board is a server-rendered dashboard opened directly in a BROWSER. The
 * app's authorization is a Bearer JWT the mobile client attaches per request —
 * a browser navigating to /admin/queues sends no Authorization header and there
 * is no cookie session to fall back on, so a JWT guard would make the dashboard
 * unreachable by the very operators it exists for. Basic Auth is the standard,
 * browser-native fit for this one non-API surface, and the credentials are
 * distinct from any user account (see BULL_BOARD_USER / BULL_BOARD_PASSWORD).
 *
 * Fail-closed: if credentials are not configured, EVERY request is refused —
 * the dashboard is never reachable unauthenticated by accident.
 */
@Injectable()
export class BullBoardAuthMiddleware implements NestMiddleware {
  private readonly logger = new Logger(BullBoardAuthMiddleware.name);
  private readonly config: BullBoardConfig;

  constructor(config: ConfigService) {
    this.config = resolveBullBoardConfig(config);
  }

  use(req: Request, res: Response, next: NextFunction): void {
    if (!this.config.user || !this.config.password) {
      // Misconfiguration must never mean "open" — refuse and say why in the log
      // (never in the response, which stays a generic 401).
      this.logger.error(
        'Bull Board is mounted but BULL_BOARD_USER/BULL_BOARD_PASSWORD are unset — denying all access.',
      );
      this.deny(res);
      return;
    }

    const header = req.headers.authorization ?? '';
    const [scheme, encoded] = header.split(' ');
    if (scheme?.toLowerCase() !== 'basic' || !encoded) {
      this.deny(res);
      return;
    }

    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    // Split on the FIRST colon only: a password may legitimately contain colons.
    const separator = decoded.indexOf(':');
    if (separator === -1) {
      this.deny(res);
      return;
    }
    const user = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);

    // Both comparisons always run — no early return on a bad username — so the
    // response time doesn't reveal which half was wrong.
    const userOk = safeEqual(user, this.config.user);
    const passwordOk = safeEqual(password, this.config.password);
    if (!userOk || !passwordOk) {
      this.logger.warn(
        `Rejected Bull Board access attempt from ${req.ip ?? 'unknown'}`,
      );
      this.deny(res);
      return;
    }

    next();
  }

  /** Generic 401 + Basic challenge. Never distinguishes the failure reason. */
  private deny(res: Response): void {
    res.setHeader('WWW-Authenticate', 'Basic realm="Queue Dashboard"');
    // Dashboards must never be cached by an intermediary.
    res.setHeader('Cache-Control', 'no-store');
    res.status(401).send('Unauthorized');
  }
}
