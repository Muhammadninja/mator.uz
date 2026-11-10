/**
 * Boot-time guard for the SMS configuration (LOW-PLT-013).
 *
 * In production the provider must be a real one, fully configured. The log
 * provider sends nothing, so falling back to it would leave phone sign-in dead
 * while the process reports itself healthy. SmsService enforces the same rule
 * when it is constructed; checking here as well stops the boot before any
 * provider exists and reports it together with the other configuration errors.
 */

/** Providers that actually deliver, with what each needs before it can send. */
export const SMS_PROVIDER_ENV: Record<string, string[]> = {
  eskiz: ['ESKIZ_EMAIL', 'ESKIZ_PASSWORD'],
  playmobile: ['PLAYMOBILE_LOGIN', 'PLAYMOBILE_PASSWORD'],
  sayqal: ['SAYQAL_USERNAME', 'SAYQAL_SECRET_KEY', 'SAYQAL_SERVICE_ID'],
};
export const REAL_SMS_PROVIDERS = Object.keys(SMS_PROVIDER_ENV);

const blank = (value: unknown) =>
  typeof value !== 'string' || value.trim() === '';

export function collectSmsEnvErrors(env: Record<string, unknown>): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const choice =
    typeof env.SMS_PROVIDER === 'string'
      ? env.SMS_PROVIDER.trim().toLowerCase()
      : '';
  const required = SMS_PROVIDER_ENV[choice];
  if (!required) {
    return [
      `SMS_PROVIDER="${choice || '(unset)'}" is not allowed in production. ` +
        `Set it to a real provider (${REAL_SMS_PROVIDERS.join(', ')}).`,
    ];
  }
  const missing = required.filter((key) => blank(env[key]));
  if (choice === 'sayqal' && !missing.includes('SAYQAL_SERVICE_ID')) {
    if (!Number.isInteger(Number(env.SAYQAL_SERVICE_ID))) {
      missing.push('SAYQAL_SERVICE_ID');
    }
  }
  return missing.length
    ? [
        `SMS_PROVIDER=${choice} is missing its credentials in production ` +
          `(${missing.join(', ')}); the log provider is not a fallback there.`,
      ]
    : [];
}

/** ConfigModule `validate` step: throws on a production SMS misconfiguration. */
export function validateSmsEnv(
  env: Record<string, unknown>,
): Record<string, unknown> {
  const errors = collectSmsEnvErrors(env);
  if (errors.length > 0) {
    throw new Error(`Invalid SMS configuration:\n  - ${errors.join('\n  - ')}`);
  }
  return env;
}
