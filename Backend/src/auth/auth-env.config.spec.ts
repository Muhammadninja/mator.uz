// The AUTH_DEV_MODE production guard, through the SAME composed validator the
// application boots with (src/env.validation.ts → ConfigModule `validate`).

import { validateEnv } from '../env.validation';
import { collectAuthEnvErrors, validateAuthEnv } from './auth-env.config';
import { ConfigService } from '@nestjs/config';
import { OtpService } from './phone/otp.service';

/** A typed ConfigService stand-in over a plain map. */
const fakeConfig = (map: Record<string, string>) =>
  ({ get: (key: string) => map[key] }) as unknown as ConfigService;

/** A production env that is otherwise valid (Payme credentials present). */
const PROD = {
  NODE_ENV: 'production',
  PAYME_MERCHANT_ID: 'merchant-1',
  PAYME_MERCHANT_KEY: 'merchant-secret',
};

describe('AUTH_DEV_MODE production guard (boot-time validateEnv)', () => {
  it('NODE_ENV=production + AUTH_DEV_MODE=true → startup rejected', () => {
    expect(() => validateEnv({ ...PROD, AUTH_DEV_MODE: 'true' })).toThrow(
      /AUTH_DEV_MODE=true is forbidden in production/,
    );
  });

  it.each(['TRUE', ' true ', 'True'])(
    'refuses near-miss spellings too (%p)',
    (value) => {
      expect(() => validateEnv({ ...PROD, AUTH_DEV_MODE: value })).toThrow(
        /AUTH_DEV_MODE/,
      );
    },
  );

  it('NODE_ENV=production + AUTH_DEV_MODE=false → startup allowed', () => {
    expect(() =>
      validateEnv({ ...PROD, AUTH_DEV_MODE: 'false' }),
    ).not.toThrow();
  });

  it('NODE_ENV=production without AUTH_DEV_MODE → startup allowed', () => {
    expect(() => validateEnv({ ...PROD })).not.toThrow();
  });

  it('NODE_ENV=development + AUTH_DEV_MODE=true → allowed (dev behaviour kept)', () => {
    expect(() =>
      validateEnv({ NODE_ENV: 'development', AUTH_DEV_MODE: 'true' }),
    ).not.toThrow();
  });

  it('the test environment is unaffected', () => {
    expect(() =>
      validateEnv({ NODE_ENV: 'test', AUTH_DEV_MODE: 'true' }),
    ).not.toThrow();
  });

  it('passes the (Payme-materialised) env through unchanged otherwise', () => {
    const out = validateEnv({ ...PROD });
    expect(out.PAYME_MERCHANT_KEY).toBe('merchant-secret');
    expect(validateAuthEnv({ A: 1 })).toEqual({ A: 1 });
  });

  it('reports a readable reason', () => {
    expect(
      collectAuthEnvErrors({ NODE_ENV: 'production', AUTH_DEV_MODE: 'true' }),
    ).toHaveLength(1);
  });
});

describe('OtpService — defence in depth behind the boot guard', () => {
  const deps = [{}, {}] as const;
  const rateLimiter = { consume: jest.fn() };

  it('refuses to construct with dev mode ON in production', () => {
    expect(
      () =>
        new OtpService(
          deps[0] as never,
          deps[1] as never,
          fakeConfig({ NODE_ENV: 'production', AUTH_DEV_MODE: 'true' }),
          rateLimiter as never,
        ),
    ).toThrow(/forbidden in production/);
  });

  it('constructs normally in development with dev mode ON', () => {
    expect(
      () =>
        new OtpService(
          deps[0] as never,
          deps[1] as never,
          fakeConfig({ NODE_ENV: 'development', AUTH_DEV_MODE: 'true' }),
          rateLimiter as never,
        ),
    ).not.toThrow();
  });
});
