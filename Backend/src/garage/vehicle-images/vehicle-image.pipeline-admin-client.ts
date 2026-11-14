import {
  BadGatewayException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  readVehicleImageConfig,
  type VehicleImageConfig,
} from './vehicle-image.config';
import { networkErrorCode } from './vehicle-image.pipeline-client';

/**
 * Server-side client for the pipeline's administrator API, used only by the
 * admin review console (/v1/admin/vehicle-images). The pipeline's admin token
 * stays here: the console authenticates against the backend with an
 * administrator's own session, and the backend records who did what.
 *
 * The pipeline's own error messages (written by its developers, never provider
 * text) are passed through with their status, so the console can show why a
 * decision was refused.
 */
export interface PipelineActor {
  id: string;
  email: string;
  name: string;
}

export interface ReviewQueueEntry {
  requestId: string;
  identityKey: string;
  subjectKey: string | null;
  identity: Record<string, unknown>;
  vehicle: Record<string, unknown>;
  verification: 'verified' | 'unverified';
  status: string;
  identityReviewRequired: boolean;
  job: Record<string, unknown> | null;
  candidates: Array<Record<string, unknown> & { id: string; status: string }>;
  members: Array<{ identityKey: string; year: number }>;
  publication: { version: number; url: string | null; identityConfirmed: boolean } | null;
  createdAt: string;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Pipeline ids are UUIDs; anything else never reaches a URL. */
const PIPELINE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const PASS_THROUGH = new Set([400, 404, 409, 413, 415, 422, 503]);

@Injectable()
export class VehicleImagePipelineAdminClient {
  private readonly config: VehicleImageConfig;
  /** Swappable in tests. */
  fetchImpl: FetchLike = (input, init) => fetch(input, init);

  constructor(config: ConfigService) {
    this.config = readVehicleImageConfig((key) => config.get(key));
  }

  /** The review console works only with a pipeline URL and its admin token. */
  get available(): boolean {
    return !!this.config.baseUrl && !!this.config.adminToken;
  }

  async reviewQueue(): Promise<ReviewQueueEntry[]> {
    return this.json('GET', 'admin/review-queue');
  }

  async metrics(): Promise<Record<string, unknown>> {
    return this.json('GET', 'admin/metrics');
  }

  async history(requestId: string): Promise<Record<string, unknown>> {
    return this.json('GET', `admin/requests/${checkedId(requestId)}/history`);
  }

  async approve(
    candidateId: string,
    body: { actor: PipelineActor; identityConfirmation?: unknown; scope?: unknown },
  ): Promise<Record<string, unknown>> {
    return this.json('POST', `admin/candidates/${checkedId(candidateId)}/approve`, body);
  }

  async reject(
    candidateId: string,
    body: { actor: PipelineActor; reason?: string | null },
  ): Promise<Record<string, unknown>> {
    return this.json('POST', `admin/candidates/${checkedId(candidateId)}/reject`, body);
  }

  async retry(requestId: string, body: { actor: PipelineActor }): Promise<Record<string, unknown>> {
    return this.json('POST', `admin/requests/${checkedId(requestId)}/retry`, body);
  }

  async upload(
    requestId: string,
    body: { contentType: string; data: string; actor: PipelineActor },
  ): Promise<Record<string, unknown>> {
    return this.json('POST', `admin/requests/${checkedId(requestId)}/candidates`, body);
  }

  /** A private candidate's bytes, for the reviewer only. */
  async preview(candidateId: string): Promise<{ bytes: Buffer; contentType: string }> {
    const response = await this.send('GET', `admin/candidates/${checkedId(candidateId)}/preview`);
    const contentType = response.headers.get('content-type') ?? '';
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(contentType))
      throw new BadGatewayException('vehicle image pipeline returned an unexpected preview');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES)
      throw new BadGatewayException('vehicle image pipeline preview is too large');
    return { bytes, contentType };
  }

  private async json<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const response = await this.send(method, path, body);
    const raw = await response.text();
    if (raw.length > MAX_JSON_BYTES)
      throw new BadGatewayException('vehicle image pipeline answer is too large');
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new BadGatewayException('vehicle image pipeline answered outside its contract');
    }
  }

  private async send(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    if (!this.available)
      throw new ServiceUnavailableException(
        'Vehicle image review is not configured (VEHICLE_IMAGE_PIPELINE_URL and VEHICLE_IMAGE_ADMIN_TOKEN).',
      );
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.config.baseUrl as string).toString(), {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.config.adminToken as string}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      throw new BadGatewayException(
        `vehicle image pipeline unreachable (${name === 'TimeoutError' ? 'timeout' : networkErrorCode(err)})`,
      );
    }
    if (response.ok) return response;
    let message = `vehicle image pipeline answered HTTP ${response.status}`;
    try {
      const parsed = JSON.parse((await response.text()).slice(0, 4096)) as { error?: unknown };
      if (typeof parsed.error === 'string' && parsed.error.length <= 300) message = parsed.error;
    } catch {
      // keep the generic message
    }
    if (PASS_THROUGH.has(response.status)) throw new HttpException(message, response.status);
    throw new BadGatewayException(message);
  }
}

function checkedId(id: string): string {
  if (typeof id !== 'string' || !PIPELINE_ID.test(id))
    throw new HttpException('unknown vehicle image request or candidate id', 400);
  return id;
}
