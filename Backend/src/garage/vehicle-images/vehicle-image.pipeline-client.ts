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

/**
 * Adapter for the pipeline's internal routes (Phase 3D, MatorUI- 567bdfc):
 *
 *   POST /internal/v1/vehicle-images/requests  body {identity, vehicle}
 *        200 when an approved asset already exists, else 202
 *   POST /internal/v1/vehicle-images/resolve   body {identity}  → 200
 *
 * Both need `Authorization: Bearer <VEHICLE_IMAGE_REQUEST_TOKEN>` (403 otherwise).
 * Both return `{identityKey, identity, status, requestId, jobId, asset}`, and
 * `requests` adds `{duplicate, reused, deduplicated}`. Pipeline errors are
 * `{error}` with 400 (validation / bad JSON), 403, 404 or 413.
 *
 * `requests` is idempotent per identity. The pipeline coalesces duplicates, reuses
 * an approved asset, and does not start a new job after a failed or rejected one.
 * Retrying it after a timeout is therefore safe.
 */
export const PIPELINE_STATUSES = [
  'not_found',
  'pending',
  'queued',
  'running',
  'awaiting_approval',
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
  asset: { url: string | null; version: number; catalogAssetKey?: string } | null;
}

/**
 * `retryable` = worth trying again later (network, timeout, 5xx, 429, 401/403/404,
 * which are usually proxy or token configuration). Otherwise the pipeline refused
 * the request itself, or answered outside its contract.
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
const PERMANENT_HTTP = new Set([400, 413, 415, 422]);
const MAX_RESPONSE_BYTES = 64 * 1024;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

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

  get marketRegion(): string | null {
    return this.config.marketRegion;
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
      throw new PipelineCallError(timedOut ? 'timeout' : 'network', true);
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
    return parseStatusResult(parsed, expectedKey);
  }
}

/** Validate the pipeline's status body; anything unexpected is a contract mismatch. */
export function parseStatusResult(
  value: unknown,
  expectedKey: string,
): PipelineStatusResult {
  const fail = (code = 'contract_mismatch'): never => {
    throw new PipelineCallError(code, false);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const body = value as Record<string, unknown>;
  if (body.identityKey !== expectedKey) fail('identity_key_mismatch');
  if (!(PIPELINE_STATUSES as readonly unknown[]).includes(body.status)) fail();
  const requestId = body.requestId ?? null;
  if (
    requestId !== null &&
    (typeof requestId !== 'string' || !requestId || requestId.length > 64)
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
    asset = {
      url: a.url as string | null,
      version: a.version as number,
      ...(typeof catalogAssetKey === 'string' ? { catalogAssetKey } : {}),
    };
  }
  if (body.status === 'approved' && !asset) fail();
  return {
    identityKey: expectedKey,
    status: body.status as PipelineStatus,
    requestId: requestId as string | null,
    asset,
  };
}
