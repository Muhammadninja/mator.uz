import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';

/**
 * JWT issuer/audience for admin tokens. Deliberately DIFFERENT from the mobile
 * app's (`mator` / `mator-app`, see TokenService + JwtStrategy): audience is the
 * second independent reason an admin token cannot pass a user guard, and vice
 * versa, on top of the different signing key and algorithm.
 */
export const ADMIN_JWT_ISSUER = 'mator-admin';
export const ADMIN_JWT_AUDIENCE = 'mator-admin-panel';

/** Admin access tokens are short-lived: a back-office session is not a phone. */
const DEFAULT_ACCESS_TTL_SECONDS = 15 * 60; // 15m
const DEFAULT_REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60; // 7d

// Secret strength floors — see AdminAuthConfig.assertStrongSecret. Chosen to
// pass `openssl rand -base64 48` (~64 chars, ~60 distinct, ~380 bits) with a
// wide margin while rejecting hand-typed filler.
const MIN_SECRET_LENGTH = 32;
const MIN_DISTINCT_CHARS = 12;
const MIN_SECRET_ENTROPY_BITS = 96;

/**
 * Owns the admin-only JWT secret and expiration settings, kept strictly apart
 * from the user-facing JWT configuration:
 *
 *   • users  -> RS256, JWT_PRIVATE_KEY/JWT_PUBLIC_KEY (JwtKeyService)
 *   • admins -> HS256, ADMIN_JWT_SECRET (here)
 *
 * Different algorithm AND different key material, so a token minted for one
 * side can never verify on the other — the isolation does not depend on anyone
 * remembering to check a claim.
 */
@Injectable()
export class AdminAuthConfig {
  private readonly logger = new Logger(AdminAuthConfig.name);
  private readonly _secret: string;
  private readonly _accessTtlSeconds: number;
  private readonly _refreshTtlSeconds: number;

  // Resolved in the constructor (not onModuleInit) so the secret is ready when
  // AdminJwtStrategy reads it during its own construction.
  constructor(private readonly config: ConfigService) {
    const secret = this.config.get<string>('ADMIN_JWT_SECRET')?.trim();
    const isProd = this.config.get<string>('NODE_ENV') === 'production';

    if (secret) {
      this.assertStrongSecret(secret);
      this._secret = secret;
    } else {
      // Production must never run on an ephemeral secret: every admin session
      // would die on restart and differ across instances. Fail fast at boot.
      if (isProd) {
        throw new Error(
          'ADMIN_JWT_SECRET is not configured. Set it in production (ephemeral dev secrets are disabled outside development).',
        );
      }
      this.logger.warn(
        'ADMIN_JWT_SECRET not configured — generating an EPHEMERAL dev secret. ' +
          'Admin sessions will not survive a restart. Set ADMIN_JWT_SECRET for production.',
      );
      this._secret = randomBytes(48).toString('base64');
    }

    this._accessTtlSeconds = this.positiveInt(
      'ADMIN_JWT_ACCESS_TTL_SECONDS',
      DEFAULT_ACCESS_TTL_SECONDS,
    );
    this._refreshTtlSeconds = this.positiveInt(
      'ADMIN_JWT_REFRESH_TTL_SECONDS',
      DEFAULT_REFRESH_TTL_SECONDS,
    );
  }

  /**
   * Reject a secret that is long but weak. Length alone is not strength:
   * `'x'.repeat(32)` clears a minimum-length check while carrying almost no
   * entropy, and an offline attacker guesses it instantly.
   *
   * Three cheap, deterministic checks — no wordlists, no dependencies:
   *
   *   1. minimum length (32) — the necessary condition;
   *   2. distinct-character count — catches repeated and short-cycle patterns
   *      (`aaaa…`, `abababab…`) that Shannon entropy alone rates generously;
   *   3. Shannon entropy over the string — catches skewed input that
   *      nonetheless uses many distinct characters.
   *
   * The thresholds pass anything `openssl rand -base64 48` produces (~6 bits per
   * character, 60+ distinct) with a wide margin, while rejecting hand-typed
   * filler. This is a guard against accidents, not a password-strength oracle:
   * the real instruction is to generate the secret randomly.
   */
  private assertStrongSecret(secret: string): void {
    const advice = 'Generate one with: openssl rand -base64 48';

    if (secret.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `ADMIN_JWT_SECRET is too short (minimum ${MIN_SECRET_LENGTH} characters). ${advice}`,
      );
    }

    const counts = new Map<string, number>();
    for (const ch of secret) counts.set(ch, (counts.get(ch) ?? 0) + 1);

    if (counts.size < MIN_DISTINCT_CHARS) {
      throw new Error(
        `ADMIN_JWT_SECRET is too repetitive (only ${counts.size} distinct characters; ` +
          `at least ${MIN_DISTINCT_CHARS} required). A long but repeated string carries ` +
          `almost no entropy. ${advice}`,
      );
    }

    // Shannon entropy per character, times length = total bits.
    let bitsPerChar = 0;
    for (const count of counts.values()) {
      const p = count / secret.length;
      bitsPerChar -= p * Math.log2(p);
    }
    const totalBits = bitsPerChar * secret.length;

    if (totalBits < MIN_SECRET_ENTROPY_BITS) {
      throw new Error(
        `ADMIN_JWT_SECRET is too predictable (~${Math.round(totalBits)} bits of entropy; ` +
          `at least ${MIN_SECRET_ENTROPY_BITS} required). ${advice}`,
      );
    }
  }

  /** Read a positive integer from env, falling back to `fallback` when unset/invalid. */
  private positiveInt(key: string, fallback: number): number {
    const raw = this.config.get<string>(key);
    if (raw === undefined || raw === null || `${raw}`.trim() === '')
      return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      this.logger.warn(
        `${key}="${raw}" is not a positive integer — using default ${fallback}s.`,
      );
      return fallback;
    }
    return parsed;
  }

  /** HS256 signing/verification secret. Never logged. */
  get secret(): string {
    return this._secret;
  }

  get accessTtlSeconds(): number {
    return this._accessTtlSeconds;
  }

  get refreshTtlSeconds(): number {
    return this._refreshTtlSeconds;
  }
}
