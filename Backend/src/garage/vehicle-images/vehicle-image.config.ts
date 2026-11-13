/**
 * Vehicle Image Pipeline integration settings (server-only, never sent to a client).
 *
 *   VEHICLE_IMAGES_ENABLED              'true' turns the integration on. Default OFF:
 *                                       nothing is written for new vehicles and nothing
 *                                       calls the pipeline. Requesting a new identity can
 *                                       start paid generation on the pipeline side.
 *   VEHICLE_IMAGE_PIPELINE_URL          Base URL of the pipeline (may carry a path prefix
 *                                       when served behind the reverse proxy). https, or
 *                                       http to a loopback host only.
 *   VEHICLE_IMAGE_REQUEST_TOKEN         The pipeline's VEHICLE_IMAGE_REQUEST_TOKEN
 *                                       (server-to-server bearer, ≥32 chars). Never the
 *                                       admin token.
 *   VEHICLE_IMAGE_MARKET_REGION         Retired and ignored. A vehicle's market comes from
 *                                       the verified vehicle image registry, per vehicle
 *                                       (vehicle-image.catalog.ts), never from a global
 *                                       setting. A leftover value does not stop boot.
 *   VEHICLE_IMAGE_REQUEST_TIMEOUT_MS    Per-call timeout for queue calls, 1000–60000
 *                                       (default 10000). The status-refresh endpoint uses
 *                                       min(this, 3000).
 *
 * Boot refuses an enabled integration that is not fully configured; a disabled one
 * needs nothing.
 */
export interface VehicleImageConfig {
  enabled: boolean;
  baseUrl: string | null;
  requestToken: string | null;
  requestTimeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
/** The pipeline refuses to start with a shorter request token. */
const MIN_TOKEN_LENGTH = 32;

const text = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

export function parseVehicleImageConfig(get: (key: string) => unknown): {
  config: VehicleImageConfig;
  errors: string[];
} {
  const errors: string[] = [];
  const enabled = text(get('VEHICLE_IMAGES_ENABLED')).toLowerCase() === 'true';

  let requestTimeoutMs = DEFAULT_TIMEOUT_MS;
  const rawTimeout = text(get('VEHICLE_IMAGE_REQUEST_TIMEOUT_MS'));
  if (rawTimeout) {
    const value = Number(rawTimeout);
    if (Number.isInteger(value) && value >= 1_000 && value <= 60_000)
      requestTimeoutMs = value;
    else
      errors.push(
        'VEHICLE_IMAGE_REQUEST_TIMEOUT_MS must be a whole number of ms from 1000 to 60000.',
      );
  }

  let baseUrl: string | null = null;
  const rawUrl = text(get('VEHICLE_IMAGE_PIPELINE_URL'));
  if (rawUrl) {
    try {
      const url = new URL(rawUrl);
      const secure =
        url.protocol === 'https:' ||
        (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
      if (!secure) {
        errors.push(
          'VEHICLE_IMAGE_PIPELINE_URL must use https (http is allowed only to a loopback host).',
        );
      } else if (url.username || url.password || url.search || url.hash) {
        errors.push(
          'VEHICLE_IMAGE_PIPELINE_URL must not carry credentials, a query or a fragment.',
        );
      } else {
        baseUrl = url.toString().endsWith('/')
          ? url.toString()
          : `${url.toString()}/`;
      }
    } catch {
      errors.push('VEHICLE_IMAGE_PIPELINE_URL is not a valid URL.');
    }
  } else if (enabled) {
    errors.push(
      'VEHICLE_IMAGE_PIPELINE_URL is required when VEHICLE_IMAGES_ENABLED=true.',
    );
  }

  let requestToken: string | null = null;
  const rawToken = text(get('VEHICLE_IMAGE_REQUEST_TOKEN'));
  if (rawToken) {
    if (rawToken.length < MIN_TOKEN_LENGTH || /\s/.test(rawToken)) {
      errors.push(
        `VEHICLE_IMAGE_REQUEST_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters with no whitespace.`,
      );
    } else {
      requestToken = rawToken;
    }
  } else if (enabled) {
    errors.push(
      'VEHICLE_IMAGE_REQUEST_TOKEN is required when VEHICLE_IMAGES_ENABLED=true.',
    );
  }

  return {
    config: { enabled, baseUrl, requestToken, requestTimeoutMs },
    errors,
  };
}

/** Boot hook (src/env.validation.ts): only an ENABLED integration must be valid. */
export function validateVehicleImageEnv(
  env: Record<string, unknown>,
): Record<string, unknown> {
  const { config, errors } = parseVehicleImageConfig((key) => env[key]);
  if (config.enabled && errors.length > 0) {
    throw new Error(
      `Vehicle image integration misconfigured:\n  - ${errors.join('\n  - ')}`,
    );
  }
  return env;
}

/**
 * Settings to run with. Invalid while enabled is refused at boot, so here an
 * incomplete configuration simply means "off".
 */
export function readVehicleImageConfig(
  get: (key: string) => unknown,
): VehicleImageConfig {
  const { config, errors } = parseVehicleImageConfig(get);
  const usable =
    config.enabled &&
    errors.length === 0 &&
    !!config.baseUrl &&
    !!config.requestToken;
  return { ...config, enabled: usable };
}
