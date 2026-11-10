import type { LogLevel } from '@nestjs/common';

/**
 * Positive assertion of the runtime environment.
 *
 * Every production safeguard in this codebase is switched on by
 * `NODE_ENV === 'production'`: refusing AUTH_DEV_MODE, requiring the JWT keys
 * and the admin secret, Swagger behind Basic Auth, the Blueprint default,
 * refusing the SMS log provider, Payme credentials. PM2 sets NODE_ENV only when
 * started with `--env production`, so one forgotten flag, or a near-miss value
 * such as `Production` or `prod`, would turn all of them off at once and the
 * process would still start and look healthy.
 *
 * So the value is checked for what it IS, not only for what it is not:
 *
 *   • a value that is set must be one of {@link KNOWN_NODE_ENVS}, exactly;
 *   • a process managed by PM2 (the production topology, see
 *     ecosystem.config.js) must have it set. An unset NODE_ENV stays legal for
 *     a developer's `nest start` and for scripts.
 *
 * Runs from ConfigModule's `validate` hook, before any provider exists.
 */
export const KNOWN_NODE_ENVS = ['production', 'development', 'test', 'staging'];

/** PM2 exports these to every process it manages. */
function managedByPm2(env: Record<string, unknown>): boolean {
  return env.pm_id !== undefined || env.PM2_HOME !== undefined;
}

export function collectRuntimeEnvErrors(
  env: Record<string, unknown>,
): string[] {
  const raw = env.NODE_ENV;
  const errors: string[] = [];
  if (raw === undefined || raw === null || raw === '') {
    if (managedByPm2(env)) {
      errors.push(
        'NODE_ENV is not set, but this process is managed by PM2. Production safeguards ' +
          'are keyed on NODE_ENV=production and would all be off. Start it with ' +
          '`pm2 start ecosystem.config.js --env production` (or set NODE_ENV explicitly).',
      );
    }
    return errors;
  }
  if (typeof raw !== 'string' || !KNOWN_NODE_ENVS.includes(raw)) {
    errors.push(
      `NODE_ENV=${JSON.stringify(raw)} is not recognised. Use exactly one of: ` +
        `${KNOWN_NODE_ENVS.join(', ')}. A misspelt "production" would silently ` +
        'disable every production safeguard.',
    );
  }
  return errors;
}

/** ConfigModule `validate` step: throws on an ambiguous runtime environment. */
export function validateRuntimeEnv(
  env: Record<string, unknown>,
): Record<string, unknown> {
  const errors = collectRuntimeEnvErrors(env);
  if (errors.length > 0) {
    throw new Error(
      `Invalid runtime environment:\n  - ${errors.join('\n  - ')}`,
    );
  }
  return env;
}

const PRODUCTION_LEVELS: LogLevel[] = ['fatal', 'error', 'warn', 'log'];
const ALL_LEVELS: LogLevel[] = [...PRODUCTION_LEVELS, 'debug', 'verbose'];

/**
 * Logger levels for the process. Production logs carry no `debug`/`verbose`
 * lines unless LOG_LEVEL asks for them: those lines are written for a developer
 * at a terminal, are kept for two weeks by PM2, and are where routine detail
 * (job payload hints, per-request traces) accumulates. Errors, warnings and the
 * operational `log` lines are always kept.
 */
export function resolveLogLevels(env: {
  NODE_ENV?: string;
  LOG_LEVEL?: string;
}): LogLevel[] {
  const wanted = env.LOG_LEVEL?.trim().toLowerCase();
  if (wanted === 'verbose') return ALL_LEVELS;
  if (wanted === 'debug') return [...PRODUCTION_LEVELS, 'debug'];
  if (wanted === 'log') return PRODUCTION_LEVELS;
  if (wanted === 'warn') return ['fatal', 'error', 'warn'];
  if (wanted === 'error') return ['fatal', 'error'];
  return env.NODE_ENV === 'production' ? PRODUCTION_LEVELS : ALL_LEVELS;
}
