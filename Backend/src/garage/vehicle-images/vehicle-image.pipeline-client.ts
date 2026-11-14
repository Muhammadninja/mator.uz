import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  canonicalIdentityKey,
  type CanonicalVehicleIdentity,
  type VehicleImageDisplay,
} from './vehicle-image.identity';
import {
  readVehicleImageConfig,
  type VehicleImageConfig,
} from './vehicle-image.config';
import { VEHICLE_IMAGE_REGISTRY_SHA256 } from './vehicle-image.catalog';

/**
 * Adapter for the pipeline's internal routes (MatorUI- services/vehicle-image-pipeline.mjs):
 *
 *   POST /internal/v1/vehicle-images/requests  body {identity, vehicle}
 *        200 when an approved asset already exists, else 202
 *   POST /internal/v1/vehicle-images/resolve   body {identity}  → 200
 *   GET  /health/ready                          → {status, registry, contract, capabilities}
 *
 * Both internal routes need `Authorization: Bearer <VEHICLE_IMAGE_REQUEST_TOKEN>`
 * (403 otherwise). This client speaks contract 2 (`x-mator-vehicle-image-contract`):
 * answers carry the registry fingerprint, the subject key, `awaiting_source`
 * and whether a person confirmed the identity of a published image. An answer
 * without a registry fingerprint (an older pipeline) or with another one is
 * refused, so the backend never applies a state computed from a different
 * registry.
 *
 * `requests` is idempotent per identity. The pipeline coalesces duplicates and
 * shares one job per subject; retrying it after a timeout is safe.
 */
export const PIPELINE_CONTRACT_VERSION = 2;
export const PIPELINE_STATUSES = [
  'not_found',
  'pending',
  'queued',
  'running',
  'awaiting_approval',
  'awaiting_source',
  'failed',
  'rejected',
  'approved',
  'needs_review',
] as const;
export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

export interface PipelineStatusResult {
  identityKey: string;
  status: PipelineStatus;
  requestId: string | null;
  subjectKey?: string | null;
  asset: {
    url: string | null;
    version: number;
    catalogAssetKey?: string;
    /** True when the published image's identity is verified or a person confirmed it. */
    identityConfirmed?: boolean;
  } | null;
}

export interface PipelineHealth {
  ready: boolean;
  registrySha256: string | null;
  registryMatches: boolean;
  contract: number | null;
  capabilities: { artwork: boolean; generation: boolean; publication: boolean } | null;
}

/**
 * `retryable` = worth trying again later (network, timeout, 5xx, 429, 401/403/404,
 * which are usually proxy or token configuration, and a registry mismatch, which
 * a deployment resolves). Otherwise the pipeline refused the request itself, or
 * answered outside its contract.
 */
export class PipelineCallError extends Error {
  override readonly name = 'PipelineCallError';
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly httpStatus?: number,
  ) {
    super(code);
  }
}

const REQUESTS_PATH = 'internal/v1/vehicle-images/requests';
const RESOLVE_PATH = 'internal/v1/vehicle-images/resolve';
const HEALTH_PATH = 'health/ready';
const PERMANENT_HTTP = new Set([400, 413, 415, 422]);
const MAX_RESPONSE_BYTES = 64 * 1024;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,40}$/;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * A precise, log-safe code for a failed fetch: `network:ECONNREFUSED`,
 * `network:ENOTFOUND`, `network:CERT_HAS_EXPIRED`, `network:redirect`, … so an
 * outage names its cause without anyone reading a stack trace. Never includes a
 * message, a host or a URL.
 */
export function networkErrorCode(err: unknown): string {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const { code, message } = current as { code?: unknown; message?: unknown };
    if (typeof code === 'string' && SAFE_CODE.test(code)) return `network:${code}`;
    if (typeof message === 'string' && /redirect/i.test(message)) return 'network:redirect';
    current = (current as { cause?: unknown }).cause;
  }
  return 'network';
}

@Injectable()
export class VehicleImagePipelineClient {
  private readonly config: VehicleImageConfig;
  /** Swappable in tests; production uses Node's global fetch. */
  fetchImpl: FetchLike = (input, init) => fetch(input, init);

  constructor(config: ConfigService) {
    this.config = readVehicleImageConfig((key) => config.get(key));
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  get defaultTimeoutMs(): number {
    return this.config.requestTimeoutMs;
  }

  request(
    identity: CanonicalVehicleIdentity,
    display: VehicleImageDisplay,
    timeoutMs = this.config.requestTimeoutMs,
  ): Promise<PipelineStatusResult> {
    return this.call(
      REQUESTS_PATH,
      { identity, vehicle: display },
      identity,
      [200, 202],
      timeoutMs,
    );
  }

  resolve(
    identity: CanonicalVehicleIdentity,
    timeoutMs = this.config.requestTimeoutMs,
  ): Promise<PipelineStatusResult> {
    return this.call(RESOLVE_PATH, { identity }, identity, [200], timeoutMs);
  }

  /** Readiness and registry handshake. Unauthenticated, read-only, never throws. */
  async health(timeoutMs = 3_000): Promise<PipelineHealth & { error?: string }> {
    const down = (error: string): PipelineHealth & { error: string } => ({
      ready: false,
      registrySha256: null,
      registryMatches: false,
      contract: null,
      capabilities: null,
      error,
    });
    if (!this.config.baseUrl) return down('not_configured');
    try {
      const response = await this.fetchImpl(
        new URL(HEALTH_PATH, this.config.baseUrl).toString(),
        {
          method: 'GET',
          headers: { accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      const raw = await response.text();
      if (response.status !== 200) return down(`http_${response.status}`);
      const body = JSON.parse(raw.slice(0, MAX_RESPONSE_BYTES)) as Record<string, unknown>;
      const registry = body.registry as { sha256?: unknown } | undefined;
      const sha = typeof registry?.sha256 === 'string' ? registry.sha256 : null;
      const caps = body.capabilities as Record<string, unknown> | undefined;
      return {
        ready: body.status === 'ready',
        registrySha256: sha,
        registryMatches: sha === VEHICLE_IMAGE_REGISTRY_SHA256,
        contract: Number.isInteger(body.contract) ? (body.contract as number) : null,
        capabilities: caps
          ? {
              artwork: caps.artwork === true,
              generation: caps.generation === true,
              publication: caps.publication === true,
            }
          : null,
      };
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      return down(
        name === 'TimeoutError' || name === 'AbortError'
          ? 'timeout'
          : err instanceof SyntaxError
            ? 'contract_mismatch'
            : networkErrorCode(err),
      );
    }
  }

  private async call(
    path: string,
    body: unknown,
    identity: CanonicalVehicleIdentity,
    okStatuses: number[],
    timeoutMs: number,
  ): Promise<PipelineStatusResult> {
    if (
      !this.config.enabled ||
      !this.config.baseUrl ||
      !this.config.requestToken
    ) {
      throw new PipelineCallError('integration_disabled', true);
    }
    const expectedKey = canonicalIdentityKey(identity);
    let response: Response;
    let raw: string;
    try {
      response = await this.fetchImpl(
        new URL(path, this.config.baseUrl).toString(),
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            authorization: `Bearer ${this.config.requestToken}`,
            'x-mator-vehicle-image-contract': String(PIPELINE_CONTRACT_VERSION),
          },
          body: JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      raw = await response.text();
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      const timedOut = name === 'TimeoutError' || name === 'AbortError';
      throw new PipelineCallError(
        timedOut ? 'timeout' : networkErrorCode(err),
        true,
      );
    }

    if (!okStatuses.includes(response.status)) {
      const permanent = PERMANENT_HTTP.has(response.status);
      throw new PipelineCallError(
        permanent ? 'pipeline_rejected_request' : `http_${response.status}`,
        !permanent,
        response.status,
      );
    }
    if (raw.length > MAX_RESPONSE_BYTES)
      throw new PipelineCallError('contract_mismatch', false);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new PipelineCallError('contract_mismatch', false, response.status);
    }
    return parseStatusResult(parsed, expectedKey, identity);
  }
}

const isHttpsUrl = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 2048 &&
  value.startsWith('https://');

/** Validate the pipeline's status body; anything unexpected is a contract mismatch. */
export function parseStatusResult(
  value: unknown,
  expectedKey: string,
  identity?: CanonicalVehicleIdentity,
  expectedRegistry: string = VEHICLE_IMAGE_REGISTRY_SHA256,
): PipelineStatusResult {
  const fail = (code = 'contract_mismatch'): never => {
    throw new PipelineCallError(code, false);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const body = value as Record<string, unknown>;
  if (body.identityKey !== expectedKey) fail('identity_key_mismatch');
  // Registry handshake: an older pipeline sends no fingerprint, a differently
  // deployed one another fingerprint. Both are deployment states that resolve
  // themselves, so they are retryable, but nothing is applied meanwhile.
  const registry = body.registry as { sha256?: unknown } | undefined;
  if (!registry || typeof registry.sha256 !== 'string')
    throw new PipelineCallError('pipeline_outdated', true);
  if (registry.sha256 !== expectedRegistry)
    throw new PipelineCallError('registry_mismatch', true);
  if (!(PIPELINE_STATUSES as readonly unknown[]).includes(body.status)) fail();
  const requestId = body.requestId ?? null;
  if (
    requestId !== null &&
    (typeof requestId !== 'string' || !requestId || requestId.length > 64)
  )
    fail();
  const subjectKey = body.subjectKey ?? null;
  if (
    subjectKey !== null &&
    (typeof subjectKey !== 'string' || subjectKey.length > 200)
  )
    fail();
  let asset: PipelineStatusResult['asset'] = null;
  if (body.asset != null) {
    const a = body.asset as Record<string, unknown>;
    if (
      typeof a !== 'object' ||
      (a.url !== null && (typeof a.url !== 'string' || !a.url || a.url.length > 2048))
    )
      fail();
    if (!Number.isInteger(a.version) || (a.version as number) < 1) fail();
    const catalogAssetKey = a.catalogAssetKey;
    if (catalogAssetKey != null && (typeof catalogAssetKey !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(catalogAssetKey))) fail();
    if (a.url === null && !catalogAssetKey) fail();
    if (a.identityConfirmed !== undefined && typeof a.identityConfirmed !== 'boolean') fail();
    if (a.thumbnailUrl !== undefined && !isHttpsUrl(a.thumbnailUrl)) fail();
    asset = {
      url: a.url as string | null,
      version: a.version as number,
      ...(typeof catalogAssetKey === 'string' ? { catalogAssetKey } : {}),
      ...(typeof a.identityConfirmed === 'boolean'
        ? { identityConfirmed: a.identityConfirmed }
        : {}),
    };
  }
  if (body.status === 'approved' && !asset) fail();
  // An image for an unverified identity is shown only once a person confirmed it.
  if (
    body.status === 'approved' &&
    identity?.identityStatus === 'unverified' &&
    asset?.identityConfirmed !== true
  )
    fail('identity_unconfirmed');
  return {
    identityKey: expectedKey,
    status: body.status as PipelineStatus,
    requestId: requestId as string | null,
    subjectKey: subjectKey as string | null,
    asset,
  };
}
