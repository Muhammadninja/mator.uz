import { validatePaymeEnv } from './orders/webhooks/payme.config';
import { validateAuthEnv } from './auth/auth-env.config';

/**
 * Boot-time environment validation, run by ConfigModule's `validate` hook
 * (app.module.ts): each step throws on a misconfiguration, aborting startup
 * before any provider exists or any request is served.
 *
 *   • Payme: merchant id/key required in production, no blank key, https
 *     checkout URL (also materialises the Payme defaults).
 *   • Auth: AUTH_DEV_MODE=true is refused in production.
 */
export function validateEnv(
  env: Record<string, unknown>,
): Record<string, unknown> {
  return validateAuthEnv(validatePaymeEnv(env));
}
