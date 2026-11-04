/**
 * Boot-time guard for the auth configuration.
 *
 * `AUTH_DEV_MODE=true` skips SMS delivery and returns the plaintext OTP in the
 * API (`dev_otp_code`) so a frontend can sign in without an SMS provider. In
 * production that is a full account takeover: anyone can sign in as any phone
 * number. A warning in the log is not a control, so a production process
 * REFUSES TO START with it enabled — the same fail-fast posture as the Payme
 * credentials (validatePaymeEnv) and the JWT/admin keys.
 *
 * Runs from ConfigModule's `validate` hook, i.e. before any provider is
 * constructed and before a single request is served.
 */

const isProduction = (env: Record<string, unknown>) =>
  env.NODE_ENV === 'production';

/**
 * True when the value would turn dev mode on. OtpService enables it on the
 * exact string 'true'; the guard is deliberately broader (case and
 * whitespace-insensitive) so a near-miss spelling is refused too rather than
 * slipping past the check.
 */
export function isAuthDevModeValue(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}

/** Every auth misconfiguration, as human-readable lines (empty = valid). */
export function collectAuthEnvErrors(env: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (isProduction(env) && isAuthDevModeValue(env.AUTH_DEV_MODE)) {
    errors.push(
      'AUTH_DEV_MODE=true is forbidden in production: it returns OTP codes in ' +
        'API responses (dev_otp_code) and skips SMS. Unset it.',
    );
  }
  return errors;
}

/** ConfigModule `validate` step: throws on any auth misconfiguration. */
export function validateAuthEnv(
  env: Record<string, unknown>,
): Record<string, unknown> {
  const errors = collectAuthEnvErrors(env);
  if (errors.length > 0) {
    throw new Error(
      `Invalid auth configuration:\n  - ${errors.join('\n  - ')}`,
    );
  }
  return env;
}
