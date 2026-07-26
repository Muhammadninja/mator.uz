// Tests for the admin JWT configuration boundary. Focus: the secret-strength
// gate, which must reject long-but-weak values (length alone is not strength —
// 'x'.repeat(32) passes a naive minimum-length check while carrying zero
// entropy), the production fail-fast when no secret is set, and the TTL parsing.

import { AdminAuthConfig } from './admin-auth.config';
import { randomBytes } from 'crypto';

/** ConfigService stand-in backed by a plain map. */
function makeConfig(values: Record<string, string | undefined>) {
  return {
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
  };
}

const build = (values: Record<string, string | undefined>) =>
  new AdminAuthConfig(makeConfig(values) as never);

describe('AdminAuthConfig', () => {
  describe('secret strength', () => {
    it.each([
      [
        'a base64 secret from openssl rand -base64 48',
        randomBytes(48).toString('base64'),
      ],
      [
        'a hex secret from openssl rand -hex 32',
        randomBytes(32).toString('hex'),
      ],
      ['a base64url secret', randomBytes(32).toString('base64url')],
    ])('accepts %s', (_label, secret) => {
      expect(build({ ADMIN_JWT_SECRET: secret }).secret).toBe(secret);
    });

    it('rejects a secret that is long enough but a single repeated character', () => {
      // The exact case length-only validation misses.
      expect(() => build({ ADMIN_JWT_SECRET: 'x'.repeat(32) })).toThrow(
        /too repetitive/,
      );
      expect(() => build({ ADMIN_JWT_SECRET: 'x'.repeat(64) })).toThrow(
        /too repetitive/,
      );
    });

    it('rejects short-cycle patterns that look long', () => {
      // 'abababab…' and 'abcdabcd…' clear the length bar and, in the second
      // case, even a naive Shannon-bits threshold — the distinct-character
      // floor is what catches them.
      expect(() => build({ ADMIN_JWT_SECRET: 'ab'.repeat(16) })).toThrow(
        /too repetitive/,
      );
      expect(() => build({ ADMIN_JWT_SECRET: 'abcd'.repeat(16) })).toThrow(
        /too repetitive/,
      );
    });

    it('rejects a low-entropy passphrase padded to length', () => {
      expect(() => build({ ADMIN_JWT_SECRET: 'changeme'.repeat(4) })).toThrow(
        /too repetitive|too predictable/,
      );
    });

    it('rejects a secret below the minimum length', () => {
      expect(() =>
        build({ ADMIN_JWT_SECRET: randomBytes(8).toString('hex') }),
      ).toThrow(/too short/);
    });

    it('always names the generator command in the failure', () => {
      // The error has to tell the operator what to do, not just what is wrong.
      for (const bad of ['short', 'x'.repeat(40)]) {
        expect(() => build({ ADMIN_JWT_SECRET: bad })).toThrow(
          /openssl rand -base64 48/,
        );
      }
    });

    it('trims surrounding whitespace before validating', () => {
      const secret = randomBytes(48).toString('base64');
      expect(build({ ADMIN_JWT_SECRET: `  ${secret}\n` }).secret).toBe(secret);
    });
  });

  describe('missing secret', () => {
    it('fails fast in production', () => {
      expect(() => build({ NODE_ENV: 'production' })).toThrow(
        /ADMIN_JWT_SECRET is not configured/,
      );
    });

    it('generates a strong ephemeral secret in development', () => {
      const config = build({ NODE_ENV: 'development' });
      expect(config.secret.length).toBeGreaterThanOrEqual(32);
      // The generated fallback must itself pass the bar it enforces on operators.
      expect(() => build({ ADMIN_JWT_SECRET: config.secret })).not.toThrow();
    });

    it('generates a different secret on each construction', () => {
      expect(build({}).secret).not.toBe(build({}).secret);
    });
  });

  describe('expiration settings', () => {
    const secret = randomBytes(48).toString('base64');

    it('defaults to a short access TTL and a longer refresh TTL', () => {
      const config = build({ ADMIN_JWT_SECRET: secret });
      expect(config.accessTtlSeconds).toBe(15 * 60);
      expect(config.refreshTtlSeconds).toBe(7 * 24 * 60 * 60);
      // Access must always be the shorter of the two, or rotation is pointless.
      expect(config.accessTtlSeconds).toBeLessThan(config.refreshTtlSeconds);
    });

    it('honours explicit overrides', () => {
      const config = build({
        ADMIN_JWT_SECRET: secret,
        ADMIN_JWT_ACCESS_TTL_SECONDS: '300',
        ADMIN_JWT_REFRESH_TTL_SECONDS: '86400',
      });
      expect(config.accessTtlSeconds).toBe(300);
      expect(config.refreshTtlSeconds).toBe(86400);
    });

    it.each([['0'], ['-60'], ['abc'], ['1.5'], ['']])(
      'falls back to the default for the invalid TTL %p',
      (raw) => {
        const config = build({
          ADMIN_JWT_SECRET: secret,
          ADMIN_JWT_ACCESS_TTL_SECONDS: raw,
        });
        expect(config.accessTtlSeconds).toBe(15 * 60);
      },
    );
  });
});
