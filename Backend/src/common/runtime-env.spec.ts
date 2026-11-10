// INFO-2: production safeguards are keyed on NODE_ENV === 'production', so the
// variable itself is asserted. LOW-PLT-012: production log levels.

import { collectRuntimeEnvErrors, resolveLogLevels } from './runtime-env';
import { collectSmsEnvErrors } from '../sms/sms-env.config';
import { validateEnv } from '../env.validation';

describe('runtime environment assertion', () => {
  it.each(['production', 'development', 'test', 'staging'])(
    'accepts NODE_ENV=%s',
    (value) => {
      expect(collectRuntimeEnvErrors({ NODE_ENV: value, pm_id: '0' })).toEqual(
        [],
      );
    },
  );

  it.each(['Production', 'PRODUCTION', 'prod', 'production ', 'live'])(
    'refuses the near-miss NODE_ENV=%j, which would disable every safeguard',
    (value) => {
      expect(collectRuntimeEnvErrors({ NODE_ENV: value })[0]).toMatch(
        /not recognised/,
      );
    },
  );

  it('refuses a PM2-managed process with no NODE_ENV (started without --env production)', () => {
    expect(collectRuntimeEnvErrors({ pm_id: '0' })[0]).toMatch(
      /managed by PM2/,
    );
    expect(
      collectRuntimeEnvErrors({ PM2_HOME: '/home/app/.pm2' }),
    ).toHaveLength(1);
  });

  it('leaves a developer process without NODE_ENV alone', () => {
    expect(collectRuntimeEnvErrors({})).toEqual([]);
  });

  it('the boot hook reports it as a startup error', () => {
    expect(() => validateEnv({ NODE_ENV: 'prod' })).toThrow(
      /Invalid runtime environment/,
    );
    expect(() => validateEnv({ pm_id: '0' })).toThrow(/NODE_ENV is not set/);
  });
});

describe('production SMS configuration', () => {
  const prod = (env: Record<string, unknown>) =>
    collectSmsEnvErrors({ NODE_ENV: 'production', ...env });

  it('refuses the log provider, an unset provider and an unknown one', () => {
    for (const env of [{}, { SMS_PROVIDER: 'log' }, { SMS_PROVIDER: 'nope' }]) {
      expect(prod(env)[0]).toMatch(/not allowed in production/);
    }
  });

  it('refuses a real provider without its credentials', () => {
    expect(prod({ SMS_PROVIDER: 'eskiz', ESKIZ_EMAIL: 'a@b.c' })[0]).toMatch(
      /ESKIZ_PASSWORD/,
    );
    expect(
      prod({
        SMS_PROVIDER: 'sayqal',
        SAYQAL_USERNAME: 'u',
        SAYQAL_SECRET_KEY: 'k',
        SAYQAL_SERVICE_ID: 'abc',
      })[0],
    ).toMatch(/SAYQAL_SERVICE_ID/);
  });

  it('accepts a configured real provider, and anything outside production', () => {
    expect(
      prod({
        SMS_PROVIDER: 'Eskiz',
        ESKIZ_EMAIL: 'a@b.c',
        ESKIZ_PASSWORD: 'p',
      }),
    ).toEqual([]);
    expect(collectSmsEnvErrors({ NODE_ENV: 'development' })).toEqual([]);
    expect(collectSmsEnvErrors({ SMS_PROVIDER: 'log' })).toEqual([]);
  });
});

describe('log levels', () => {
  it('production drops debug and verbose', () => {
    const levels = resolveLogLevels({ NODE_ENV: 'production' });
    expect(levels).toEqual(['fatal', 'error', 'warn', 'log']);
  });

  it('LOG_LEVEL=debug is an explicit opt-in', () => {
    expect(
      resolveLogLevels({ NODE_ENV: 'production', LOG_LEVEL: 'debug' }),
    ).toContain('debug');
  });

  it('development keeps everything', () => {
    expect(resolveLogLevels({})).toEqual(
      expect.arrayContaining(['debug', 'verbose']),
    );
  });
});
