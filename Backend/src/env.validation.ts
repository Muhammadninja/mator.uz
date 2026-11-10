import { validatePaymeEnv } from './orders/webhooks/payme.config';
import { validateAuthEnv } from './auth/auth-env.config';
import { validateDeliveryEnv } from './shipping/delivery.config';
import { validateRuntimeEnv } from './common/runtime-env';
import { validateSmsEnv } from './sms/sms-env.config';
import { validateClickEnv } from './orders/webhooks/click.config';

/**
 * Boot-time environment validation, run by ConfigModule's `validate` hook
 * (app.module.ts): each step throws on a misconfiguration, aborting startup
 * before any provider exists or any request is served.
 *
 *   • Runtime: NODE_ENV is one of the known values, and is set under PM2, so the
 *     production safeguards below cannot be switched off by a missing or
 *     misspelt variable.
 *   • SMS: production names a real provider with its credentials; the log
 *     provider is refused there.
 *   • Click: stays disabled by default; if enabled, it needs its real service and
 *     merchant ids, never placeholders.
 *   • Payme: merchant id/key required in production, no blank key, https
 *     checkout URL (also materialises the Payme defaults).
 *   • Auth: AUTH_DEV_MODE=true is refused in production.
 *   • Delivery: any delivery rate or area that is set must make sense, and an area
 *     needs UZMAPS_API_KEY in production. No area at all is valid: couriers are off.
 */
export function validateEnv(
  env: Record<string, unknown>,
): Record<string, unknown> {
  return validateDeliveryEnv(
    validateAuthEnv(
      validatePaymeEnv(
        validateClickEnv(validateSmsEnv(validateRuntimeEnv(env))),
      ),
    ),
  );
}
