import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { JobsOptions, Queue } from 'bullmq';
import {
  Prisma,
  VehicleImageIdentity,
  VehicleImageOutboxStatus,
  VehicleImageStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { QUEUE_NAMES, VEHICLE_IMAGE_JOBS } from '../../queue/queue.constants';
import {
  canonicalIdentityKey,
  validateCanonicalIdentity,
  validateDisplay,
  type CanonicalVehicleIdentity,
  type VehicleImageDisplay,
} from './vehicle-image.identity';
import {
  PipelineCallError,
  VehicleImagePipelineClient,
  type PipelineHealth,
  type PipelineStatusResult,
} from './vehicle-image.pipeline-client';
import {
  IDENTITY_REASONS,
  REDISPATCHABLE_REASONS,
  stateFromPipeline,
} from './vehicle-image.state';
import { IdPrefix, prefixedId } from '../../common/ulid.util';

/** Delivery attempts per outbox row before it is given up (≈1 h of backoff in total). */
export const MAX_DISPATCH_ATTEMPTS = 8;
/** Retry delay after attempt n: 30 s · 2^(n-1), at most 15 min. */
export const dispatchBackoffMs = (attempt: number): number =>
  Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 15 * 60_000);
/** A claimed attempt that never reported back is re-offered after this. */
const DISPATCH_LEASE_MS = 2 * 60_000;
const SYNC_LEASE_MS = 5 * 60_000;
const SYNC_BATCH = 50;
const RELAY_BATCH = 100;
/** The on-demand refresh calls the pipeline at most this often per identity. */
export const REFRESH_MIN_INTERVAL_MS = 15_000;
const REFRESH_TIMEOUT_MS = 3_000;
/** An identity that never reached the pipeline is asked again after this cool-down. */
export const REVIVE_AFTER_MS = 30 * 60_000;
const REVIVE_BATCH = 50;
/** A readiness answer is reused this long, so an outage is not probed per job. */
const HEALTH_TTL_MS = 60_000;

export type DispatchOutcome =
  'dispatched' | 'retry_scheduled' | 'dead' | 'skipped';

export interface DispatchJobData {
  outboxId: string;
  /** The row's `attempts` when the job was queued; the job may claim only that attempt. */
  attempt: number;
}

/**
 * One BullMQ job per delivery attempt. The id pairs the outbox row with its
 * attempt counter, so the fast path and the relay never run the same attempt
 * twice. Retries belong to the outbox (attempts/availableAt), not to BullMQ.
 */
export function dispatchJob(
  outboxId: string,
  attempt: number,
): {
  name: string;
  data: DispatchJobData;
  opts: JobsOptions;
} {
  return {
    name: VEHICLE_IMAGE_JOBS.DISPATCH,
    data: { outboxId, attempt },
    opts: {
      jobId: `${outboxId}-a${attempt}`,
      attempts: 1,
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
    },
  };
}

type Db = Prisma.TransactionClient | PrismaService;

/**
 * Moves Garage vehicle-image requests to the pipeline and pipeline state back.
 *
 * Nothing here runs inside a Garage request except `refresh` (bounded timeout,
 * never throws). A pipeline outage only delays the outbox and the sync.
 */
@Injectable()
export class VehicleImageDeliveryService {
  private readonly logger = new Logger(VehicleImageDeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: VehicleImagePipelineClient,
    @InjectQueue(QUEUE_NAMES.VEHICLE_IMAGES) private readonly queue: Queue,
  ) {}

  get enabled(): boolean {
    return this.client.enabled;
  }

  /** Deliver one attempt of one outbox row. */
  async dispatch({
    outboxId,
    attempt,
  }: DispatchJobData): Promise<DispatchOutcome> {
    const n = attempt + 1;
    // Claim: only the job carrying the row's current attempt number gets it.
    const claimed = await this.prisma.vehicleImageOutbox.updateMany({
      where: {
        id: outboxId,
        status: VehicleImageOutboxStatus.PENDING,
        attempts: attempt,
      },
      data: {
        attempts: n,
        availableAt: new Date(Date.now() + DISPATCH_LEASE_MS),
      },
    });
    if (claimed.count === 0) return 'skipped';
    const row = await this.prisma.vehicleImageOutbox.findUnique({
      where: { id: outboxId },
      include: { identity: true },
    });
    if (!row) return 'skipped';

    const request = storedRequest(row.identity);
    if (!request) {
      this.logger.error(
        `vehicle-image outbox ${outboxId}: stored identity no longer valid`,
      );
      await this.markDead(
        outboxId,
        n,
        row.identityKey,
        'stored_identity_invalid',
      );
      return 'dead';
    }

    let result: PipelineStatusResult;
    try {
      result = await this.client.request(request.identity, request.display);
    } catch (err) {
      if (!(err instanceof PipelineCallError)) throw err;
      await this.recordError(row.identityKey, err.code);
      if (err.retryable && n < MAX_DISPATCH_ATTEMPTS) {
        await this.prisma.vehicleImageOutbox.updateMany({
          where: {
            id: outboxId,
            status: VehicleImageOutboxStatus.PENDING,
            attempts: n,
          },
          data: {
            availableAt: new Date(Date.now() + dispatchBackoffMs(n)),
            lastError: err.code,
          },
        });
        this.logger.warn(
          `vehicle-image outbox ${outboxId}: attempt ${n} failed (${err.code}); retry scheduled`,
        );
        return 'retry_scheduled';
      }
      this.logger.error(
        `vehicle-image outbox ${outboxId}: given up after attempt ${n} (${err.code})`,
      );
      await this.markDead(outboxId, n, row.identityKey, err.code);
      return 'dead';
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.vehicleImageOutbox.updateMany({
        where: {
          id: outboxId,
          status: VehicleImageOutboxStatus.PENDING,
          attempts: n,
        },
        data: {
          status: VehicleImageOutboxStatus.DISPATCHED,
          dispatchedAt: new Date(),
          lastError: null,
        },
      });
      await this.apply(tx, row.identity, result);
    });
    return 'dispatched';
  }

  /** Queue every due outbox row: rows whose fast-path enqueue was lost, and retries. */
  async relayDue(now = new Date()): Promise<number> {
    const due = await this.prisma.vehicleImageOutbox.findMany({
      where: {
        status: VehicleImageOutboxStatus.PENDING,
        availableAt: { lte: now },
      },
      orderBy: { availableAt: 'asc' },
      take: RELAY_BATCH,
      select: { id: true, attempts: true, identityKey: true },
    });
    const jobs: ReturnType<typeof dispatchJob>[] = [];
    for (const row of due) {
      if (row.attempts >= MAX_DISPATCH_ATTEMPTS) {
        // The last claimed attempt never reported back.
        await this.markDead(
          row.id,
          row.attempts,
          row.identityKey,
          'dispatch_exhausted',
        );
        continue;
      }
      jobs.push(dispatchJob(row.id, row.attempts));
    }
    if (jobs.length) await this.queue.addBulk(jobs);
    return jobs.length;
  }

  /** Re-read due identities from the pipeline (read-only on the pipeline side). */
  async syncDue(now = new Date()): Promise<number> {
    const due = await this.prisma.vehicleImageIdentity.findMany({
      where: { nextSyncAt: { lte: now }, lastSyncedAt: { not: null } },
      orderBy: { nextSyncAt: 'asc' },
      take: SYNC_BATCH,
    });
    let synced = 0;
    for (const row of due) {
      const claimed = await this.prisma.vehicleImageIdentity.updateMany({
        where: { identityKey: row.identityKey, nextSyncAt: row.nextSyncAt },
        data: { nextSyncAt: new Date(Date.now() + SYNC_LEASE_MS) },
      });
      if (claimed.count === 0) continue;
      const request = storedRequest(row);
      if (!request) {
        await this.prisma.vehicleImageIdentity.update({
          where: { identityKey: row.identityKey },
          data: { nextSyncAt: null },
        });
        continue;
      }
      try {
        const result = await this.client.resolve(request.identity);
        await this.apply(this.prisma, row, result);
        synced += 1;
      } catch (err) {
        if (!(err instanceof PipelineCallError)) throw err;
        await this.recordError(row.identityKey, err.code);
        this.logger.warn(
          `vehicle-image sync ${row.identityKey.slice(0, 12)}: ${err.code}`,
        );
        // Outage: stop this batch; the claimed row retries when its lease ends.
        if (err.retryable) break;
      }
    }
    return synced;
  }

  /**
   * On-demand status refresh for GET /v1/garage/vehicles/:id/image. Only for an
   * identity the pipeline has acknowledged, at most once per
   * REFRESH_MIN_INTERVAL_MS, with a short timeout. Never throws: on any failure the
   * caller serves the stored state.
   */
  async refresh(identityKey: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const row = await this.prisma.vehicleImageIdentity.findUnique({
        where: { identityKey },
      });
      if (!row?.lastSyncedAt) return;
      const now = new Date();
      if (now.getTime() - row.lastSyncedAt.getTime() < REFRESH_MIN_INTERVAL_MS)
        return;
      const claimed = await this.prisma.vehicleImageIdentity.updateMany({
        where: { identityKey, lastSyncedAt: row.lastSyncedAt },
        data: { lastSyncedAt: now },
      });
      if (claimed.count === 0) return;
      const request = storedRequest(row);
      if (!request) return;
      const result = await this.client.resolve(
        request.identity,
        Math.min(this.client.defaultTimeoutMs, REFRESH_TIMEOUT_MS),
      );
      await this.apply(this.prisma, row, result);
    } catch (err) {
      const code =
        err instanceof PipelineCallError
          ? err.code
          : ((err as Error)?.name ?? 'error');
      if (err instanceof PipelineCallError)
        await this.recordError(identityKey, code).catch(() => undefined);
      this.logger.warn(
        `vehicle-image refresh ${identityKey.slice(0, 12)}: ${code}`,
      );
    }
  }

  /** Re-read one identity now (administrator action, after an approval). Never throws. */
  async syncNow(identityKey: string): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const row = await this.prisma.vehicleImageIdentity.findUnique({
        where: { identityKey },
      });
      const request = row ? storedRequest(row) : null;
      if (!row || !request) return false;
      const result = await this.client.resolve(request.identity);
      await this.apply(this.prisma, row, result);
      return true;
    } catch (err) {
      if (err instanceof PipelineCallError)
        await this.recordError(identityKey, err.code).catch(() => undefined);
      return false;
    }
  }

  /** Pipeline readiness and registry handshake, cached for a minute. */
  async health(force = false): Promise<PipelineHealth & { error?: string; checkedAt: Date }> {
    const now = Date.now();
    if (!force && this.healthCache && now - this.healthCache.checkedAt.getTime() < HEALTH_TTL_MS)
      return this.healthCache;
    this.healthCache = { ...(await this.client.health()), checkedAt: new Date(now) };
    return this.healthCache;
  }

  private healthCache: (PipelineHealth & { error?: string; checkedAt: Date }) | null = null;

  /**
   * Recovery after an outage or a deployment: identities whose request never
   * reached the pipeline (dead outbox, lost by the pipeline, or saved while the
   * integration was off) and that a live Garage vehicle still shows are asked
   * again, at most once per REVIVE_AFTER_MS, and only while the pipeline answers
   * ready with the same registry. Failed or rejected generations are never
   * restarted here: only an administrator does that.
   */
  async reviveStalled(now = new Date()): Promise<number> {
    if (!this.enabled) return 0;
    const health = await this.health();
    if (!health.ready || !health.registryMatches) return 0;
    const stale = await this.prisma.vehicleImageIdentity.findMany({
      where: {
        status: VehicleImageStatus.UNAVAILABLE,
        reason: { in: [...REDISPATCHABLE_REASONS] },
        updatedAt: { lt: new Date(now.getTime() - REVIVE_AFTER_MS) },
        vehicles: { some: { deletedAt: null } },
        outbox: { none: { status: VehicleImageOutboxStatus.PENDING } },
      },
      orderBy: { updatedAt: 'asc' },
      take: REVIVE_BATCH,
      select: { identityKey: true, reason: true },
    });
    const jobs: ReturnType<typeof dispatchJob>[] = [];
    for (const row of stale) {
      const id = prefixedId(IdPrefix.VEHICLE_IMAGE_OUTBOX);
      const revived = await this.prisma.$transaction(async (tx) => {
        const reset = await tx.vehicleImageIdentity.updateMany({
          where: {
            identityKey: row.identityKey,
            status: VehicleImageStatus.UNAVAILABLE,
            reason: row.reason,
          },
          data: {
            status: VehicleImageStatus.PENDING,
            reason: null,
            imageUrl: null,
            imageVersion: null,
            catalogAssetKey: null,
            lastSyncedAt: null,
            nextSyncAt: null,
          },
        });
        if (reset.count === 0) return false;
        // The partial unique index keeps one PENDING outbox row per identity.
        const created = await tx.vehicleImageOutbox.createMany({
          data: [{ id, identityKey: row.identityKey, availableAt: now }],
          skipDuplicates: true,
        });
        return created.count === 1;
      });
      if (revived) jobs.push(dispatchJob(id, 0));
    }
    if (jobs.length) {
      await this.queue.addBulk(jobs);
      this.logger.log(`vehicle-image revive: ${jobs.length} identities asked again`);
    }
    return jobs.length;
  }

  private async recordError(identityKey: string, code: string): Promise<void> {
    await this.prisma.vehicleImageIdentity.updateMany({
      where: { identityKey },
      data: { lastError: code.slice(0, 120), lastErrorAt: new Date() },
    });
  }

  private async apply(
    db: Db,
    previous: VehicleImageIdentity,
    result: PipelineStatusResult,
  ): Promise<void> {
    const now = new Date();
    const next = stateFromPipeline(result, now, previous);
    await db.vehicleImageIdentity.update({
      where: { identityKey: previous.identityKey },
      data: { ...next, lastSyncedAt: now, lastError: null, lastErrorAt: null },
    });
  }

  private async markDead(
    outboxId: string,
    attempts: number,
    identityKey: string,
    code: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.vehicleImageOutbox.updateMany({
        where: {
          id: outboxId,
          status: VehicleImageOutboxStatus.PENDING,
          attempts,
        },
        data: {
          status: VehicleImageOutboxStatus.DEAD,
          lastError: code.slice(0, 200),
        },
      });
      // Only an identity still waiting on this delivery becomes unavailable.
      await tx.vehicleImageIdentity.updateMany({
        where: {
          identityKey,
          status: VehicleImageStatus.PENDING,
          lastSyncedAt: null,
        },
        data: {
          status: VehicleImageStatus.UNAVAILABLE,
          reason: IDENTITY_REASONS.DISPATCH_FAILED,
          nextSyncAt: null,
        },
      });
    });
  }
}

/** The identity + display stored on the row, re-validated and re-hashed. */
function storedRequest(
  row: Pick<VehicleImageIdentity, 'identityKey' | 'identity' | 'display'>,
): { identity: CanonicalVehicleIdentity; display: VehicleImageDisplay } | null {
  try {
    const identity = validateCanonicalIdentity(row.identity);
    if (canonicalIdentityKey(identity) !== row.identityKey) return null;
    const display = validateDisplay(
      row.display as unknown as VehicleImageDisplay,
      identity,
    );
    return { identity, display };
  } catch {
    return null;
  }
}
