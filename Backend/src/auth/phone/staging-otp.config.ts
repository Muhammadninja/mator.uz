/**
 * Staging tester OTP: configuration and its boot-time checks.
 *
 * On a staging server no SMS is sent. Instead, a code requested by an approved
 * tester for one of THEIR phone numbers is kept, encrypted, for that tester to
 * read (GET /v1/staging/otp/inbox). Who the tester is comes from the staging
 * proxy, never from the app:
 *
 *   • Nginx accepts a request only with a valid per-tester access token, maps the
 *     token to a tester id, and sets two headers on the proxied request:
 *     `X-Mator-Staging-Tester: <tester id>` and
 *     `X-Mator-Staging-Proxy-Auth: <STAGING_PROXY_SECRET>`. Both overwrite any
 *     value a client sent, and the token itself is not forwarded.
 *   • The server believes the tester id only when the proxy secret matches, and
 *     only for ids listed in STAGING_OTP_TESTERS, each bound to its numbers.
 *
 * Off unless STAGING_OTP_ENABLED is exactly `true` on NODE_ENV=staging. Refused
 * at boot in production, with AUTH_DEV_MODE, or against the production database.
 *
 * Environment:
 *   STAGING_OTP_ENABLED   `true` to turn it on (staging only)
 *   STAGING_OTP_TESTERS   `tester-01=+998901234567,tester-02=+998935551234|+998971112233`
 *   STAGING_PROXY_SECRET  ≥32 characters, shared with Nginx only
 *   OTP_JOB_ENCRYPTION_KEY  the existing OTP encryption key (codes are sealed with it)
 */

import {
  OTP_JOB_KEY_ENV,
  parseOtpJobKey,
} from '../../queue/otp-job-secret.store';

export const STAGING_OTP_ENABLED_ENV = 'STAGING_OTP_ENABLED';
export const STAGING_OTP_TESTERS_ENV = 'STAGING_OTP_TESTERS';
export const STAGING_PROXY_SECRET_ENV = 'STAGING_PROXY_SECRET';

/** Set by the staging proxy only; lower-case as Node exposes them. */
export const STAGING_TESTER_HEADER = 'x-mator-staging-tester';
export const STAGING_PROXY_AUTH_HEADER = 'x-mator-staging-proxy-auth';

/** The production database's name: a staging OTP mode never runs against it. */
export const PRODUCTION_DATABASE_NAME = 'mator';

const MIN_PROXY_SECRET_LENGTH = 32;
const TESTER_ID = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const E164 = /^\+[1-9]\d{7,14}$/;

export interface StagingTester {
  id: string;
  /** E.164 numbers this tester may request and verify codes for. */
  phones: readonly string[];
}

export interface StagingOtpConfig {
  enabled: boolean;
  testers: ReadonlyMap<string, StagingTester>;
  proxySecret: string;
}

const text = (value: unknown) =>
  typeof value === 'string' ? value.trim() : '';

/** The exact switch, as OtpService reads it. */
function isOn(value: unknown): boolean {
  return text(value) === 'true';
}

/** Broader than {@link isOn}: a near-miss spelling is still refused in production. */
function looksOn(value: unknown): boolean {
  return text(value).toLowerCase() === 'true';
}

export function parseStagingTesters(raw: unknown): {
  testers: Map<string, StagingTester>;
  errors: string[];
} {
  const testers = new Map<string, StagingTester>();
  const errors: string[] = [];
  const owner = new Map<string, string>();
  for (const entry of text(raw)
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)) {
    const [id, numbers, ...rest] = entry.split('=').map((p) => p.trim());
    if (!TESTER_ID.test(id ?? '') || !numbers || rest.length) {
      errors.push(
        `${STAGING_OTP_TESTERS_ENV}: each entry is "<tester id>=<+E164>[|<+E164>…]" ` +
          'with a lower-case id of 2–32 letters, digits, "-" or "_".',
      );
      continue;
    }
    if (testers.has(id)) {
      errors.push(
        `${STAGING_OTP_TESTERS_ENV}: tester "${id}" is listed twice.`,
      );
      continue;
    }
    const phones = numbers.split('|').map((p) => p.trim());
    const bad = phones.filter((p) => !E164.test(p));
    if (bad.length) {
      errors.push(
        `${STAGING_OTP_TESTERS_ENV}: tester "${id}" has a number that is not E.164.`,
      );
      continue;
    }
    // One number, one tester: a code is only ever readable by the tester it belongs to.
    const shared = phones.find((p) => owner.has(p) && owner.get(p) !== id);
    if (shared) {
      errors.push(
        `${STAGING_OTP_TESTERS_ENV}: a number is bound to more than one tester.`,
      );
      continue;
    }
    phones.forEach((p) => owner.set(p, id));
    testers.set(id, { id, phones: [...new Set(phones)] });
  }
  return { testers, errors };
}

function databaseName(url: unknown): string | null {
  try {
    return (
      decodeURIComponent(new URL(text(url)).pathname.replace(/^\//, '')) || null
    );
  } catch {
    return null;
  }
}

/** Every staging OTP misconfiguration, as lines (empty = valid). */
export function collectStagingOtpEnvErrors(
  env: Record<string, unknown>,
): string[] {
  const enabled = env[STAGING_OTP_ENABLED_ENV];
  if (env.NODE_ENV === 'production') {
    return looksOn(enabled)
      ? [`${STAGING_OTP_ENABLED_ENV} is forbidden in production. Unset it.`]
      : [];
  }
  if (!looksOn(enabled)) return [];
  const errors: string[] = [];
  if (env.NODE_ENV !== 'staging') {
    errors.push(`${STAGING_OTP_ENABLED_ENV}=true requires NODE_ENV=staging.`);
  }
  if (looksOn(env.AUTH_DEV_MODE)) {
    errors.push(
      `${STAGING_OTP_ENABLED_ENV} cannot be combined with AUTH_DEV_MODE=true.`,
    );
  }
  if (text(env[STAGING_PROXY_SECRET_ENV]).length < MIN_PROXY_SECRET_LENGTH) {
    errors.push(
      `${STAGING_PROXY_SECRET_ENV} must be at least ${MIN_PROXY_SECRET_LENGTH} characters.`,
    );
  }
  const { testers, errors: testerErrors } = parseStagingTesters(
    env[STAGING_OTP_TESTERS_ENV],
  );
  errors.push(...testerErrors);
  if (!testers.size && !testerErrors.length) {
    errors.push(`${STAGING_OTP_TESTERS_ENV} must list at least one tester.`);
  }
  if (!parseOtpJobKey(env[OTP_JOB_KEY_ENV])) {
    errors.push(
      `${OTP_JOB_KEY_ENV} must be set: staging codes are stored encrypted with it.`,
    );
  }
  if (databaseName(env.DATABASE_URL) === PRODUCTION_DATABASE_NAME) {
    errors.push(
      `${STAGING_OTP_ENABLED_ENV} refuses to run against the production database.`,
    );
  }
  return errors;
}

/**
 * The runtime view. Anything short of a complete, valid staging configuration
 * reads as disabled with no testers, so a half-configured process grants nothing.
 */
export function readStagingOtpConfig(
  get: (key: string) => string | undefined,
): StagingOtpConfig {
  const off: StagingOtpConfig = {
    enabled: false,
    testers: new Map(),
    proxySecret: '',
  };
  if (!isOn(get(STAGING_OTP_ENABLED_ENV)) || get('NODE_ENV') !== 'staging')
    return off;
  if (looksOn(get('AUTH_DEV_MODE'))) return off;
  const proxySecret = text(get(STAGING_PROXY_SECRET_ENV));
  const { testers, errors } = parseStagingTesters(get(STAGING_OTP_TESTERS_ENV));
  if (
    proxySecret.length < MIN_PROXY_SECRET_LENGTH ||
    errors.length ||
    !testers.size
  )
    return off;
  return { enabled: true, testers, proxySecret };
}
