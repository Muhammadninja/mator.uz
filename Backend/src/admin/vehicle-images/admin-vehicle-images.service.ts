import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AdminAuditAction, AdminAuditEntity, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminAuditService, type AdminAuditActor } from '../auth/admin-audit.service';
import { ALLOWED_IMAGE_MIME } from '../../common/image.constants';
import { VEHICLE_IMAGE_REGISTRY_SHA256 } from '../../garage/vehicle-images/vehicle-image.catalog';
import { VehicleImageDeliveryService } from '../../garage/vehicle-images/vehicle-image.delivery.service';
import {
  VehicleImagePipelineAdminClient,
  type ReviewQueueEntry,
} from '../../garage/vehicle-images/vehicle-image.pipeline-admin-client';
import { VehicleImageReconcileService } from '../../garage/vehicle-images/vehicle-image.reconcile.service';
import type { ApproveCandidateDto, ReconcileDto, RevertReconcileDto } from './dto/admin-vehicle-images.dto';

export interface AdminContext {
  actor: AdminAuditActor;
  ip?: string | null;
  userAgent?: string | null;
}

/** Most urgent first: work waiting on a person, then failures, then the rest. */
const STATUS_ORDER = ['awaiting_approval', 'awaiting_source', 'failed', 'rejected', 'needs_review', 'queued', 'running', 'approved'];
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

const label = (entry: Pick<ReviewQueueEntry, 'vehicle'>): string => {
  const v = entry.vehicle as { manufacturer?: unknown; model?: unknown; year?: unknown };
  return [v.manufacturer, v.model, v.year].filter((part) => part != null).join(' ').slice(0, 120);
};

/**
 * Administrator review of Garage vehicle images: status report, review queue,
 * candidate decisions, uploads, retries and re-resolution of saved vehicles.
 * Every decision goes to the pipeline under the administrator's name and is
 * written to the admin audit trail; an approval re-reads the affected Garage
 * identities at once, so owners see the image without waiting for the sync.
 */
@Injectable()
export class AdminVehicleImagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pipeline: VehicleImagePipelineAdminClient,
    private readonly delivery: VehicleImageDeliveryService,
    private readonly reconcile: VehicleImageReconcileService,
    private readonly audit: AdminAuditService,
  ) {}

  async status() {
    const [garage, identityKinds, identities, outbox, errors, health] = await Promise.all([
      this.garageCoverage(),
      this.identityKinds(),
      this.prisma.vehicleImageIdentity.groupBy({ by: ['status', 'pipelineStatus'], _count: { _all: true } }),
      this.prisma.vehicleImageOutbox.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.vehicleImageIdentity.groupBy({
        by: ['lastError'],
        where: { lastError: { not: null } },
        _count: { _all: true },
      }),
      this.delivery.health(true),
    ]);
    const pipeline = this.pipeline.available
      ? await this.pipeline.metrics().catch((err: unknown) => ({ error: (err as Error).message }))
      : null;
    const outboxCounts = Object.fromEntries(outbox.map((row) => [row.status, row._count._all]));
    const reviewQueue = typeof (pipeline as { reviewQueue?: unknown } | null)?.reviewQueue === 'number'
      ? (pipeline as { reviewQueue: number }).reviewQueue
      : null;
    const actions: string[] = [];
    if (!this.delivery.enabled) actions.push('The pipeline integration is off (VEHICLE_IMAGES_ENABLED); only approved registry images are shown.');
    else if (!health.ready)
      actions.push(`The pipeline is not usable (${health.error ?? 'not ready'}). Run scripts/vehicle-images/diagnose-pipeline.mjs on the server.`);
    else if (!health.registryMatches)
      actions.push('The pipeline runs a different vehicle image registry. Deploy the same registry commit to the pipeline and the backend.');
    if ((outboxCounts.DEAD ?? 0) > 0)
      actions.push(`${outboxCounts.DEAD} requests never reached the pipeline; they are asked again automatically once it is ready.`);
    if (reviewQueue) actions.push(`${reviewQueue} candidate images wait for review.`);
    if (!this.pipeline.available) actions.push('The review console needs VEHICLE_IMAGE_ADMIN_TOKEN on the backend.');
    return {
      generatedAt: new Date().toISOString(),
      integration: { enabled: this.delivery.enabled, reviewConsole: this.pipeline.available },
      registry: {
        backendSha256: VEHICLE_IMAGE_REGISTRY_SHA256,
        pipelineSha256: health.registrySha256,
        matches: health.registryMatches,
      },
      pipelineHealth: {
        ready: health.ready,
        error: health.error ?? null,
        contract: health.contract,
        capabilities: health.capabilities,
        checkedAt: health.checkedAt.toISOString(),
      },
      garage,
      identityKinds,
      identities: identities.map((row) => ({ status: row.status, pipelineStatus: row.pipelineStatus, count: row._count._all })),
      outbox: outboxCounts,
      lastErrors: errors.map((row) => ({ code: row.lastError, count: row._count._all })),
      pipeline,
      actions,
    };
  }

  /** Live Garage vehicles by what their picture is right now. */
  private async garageCoverage() {
    const rows = await this.prisma.$queryRaw<Array<{ state: string; count: bigint }>>`
      SELECT CASE
          WHEN v.image_review_reason IS NOT NULL THEN 'review:' || v.image_review_reason
          WHEN v.image_identity_key IS NULL THEN 'unresolved'
          WHEN i.status = 'APPROVED' AND i.catalog_asset_key IS NOT NULL THEN 'approved_registry_image'
          WHEN i.status = 'APPROVED' AND i.image_url IS NOT NULL
            AND (i.identity ? 'marketRegion' OR i.identity->>'identityStatus' = 'unverified') THEN 'approved_published_image'
          WHEN i.status = 'APPROVED' AND i.image_url IS NOT NULL THEN 'legacy_publication_hidden'
          WHEN i.status = 'PENDING'
            AND i.pipeline_status IN ('awaiting_approval', 'awaiting_source', 'needs_review') THEN 'awaiting_review'
          WHEN i.status = 'PENDING' THEN 'processing'
          WHEN i.status = 'UNAVAILABLE' THEN 'unavailable:' || COALESCE(i.reason, 'unknown')
          ELSE 'other'
        END AS state,
        count(*) AS count
      FROM vehicles v
      LEFT JOIN vehicle_image_identities i ON i.identity_key = v.image_identity_key
      WHERE v.deleted_at IS NULL
      GROUP BY 1
      ORDER BY 1`;
    const byState = Object.fromEntries(rows.map((row) => [row.state, Number(row.count)]));
    const total = Object.values(byState).reduce((sum, n) => sum + n, 0);
    const withImage = (byState.approved_registry_image ?? 0) + (byState.approved_published_image ?? 0);
    return {
      liveVehicles: total,
      withVerifiedImage: withImage,
      coveragePercent: total ? Math.round((withImage / total) * 1000) / 10 : null,
      byState,
    };
  }

  /** Distinct identities the Garage uses, by how well they are known. */
  private async identityKinds() {
    const rows = await this.prisma.$queryRaw<Array<{ kind: string; count: bigint }>>`
      SELECT CASE
          WHEN i.identity ? 'marketRegion' THEN 'verified'
          WHEN i.identity->>'identityStatus' = 'unverified' THEN 'unverified'
          ELSE 'legacy'
        END AS kind,
        count(DISTINCT i.identity_key) AS count
      FROM vehicle_image_identities i
      WHERE EXISTS (SELECT 1 FROM vehicles v WHERE v.image_identity_key = i.identity_key AND v.deleted_at IS NULL)
      GROUP BY 1`;
    return Object.fromEntries(rows.map((row) => [row.kind, Number(row.count)]));
  }

  async queue() {
    const entries = await this.pipeline.reviewQueue();
    const keys = entries.flatMap((entry) => [entry.identityKey, ...entry.members.map((m) => m.identityKey)]);
    const counts = keys.length
      ? await this.prisma.vehicle.groupBy({
          by: ['imageIdentityKey'],
          where: { deletedAt: null, imageIdentityKey: { in: keys } },
          _count: { _all: true },
        })
      : [];
    const perKey = new Map(counts.map((row) => [row.imageIdentityKey, row._count._all]));
    const rank = (status: string) => {
      const index = STATUS_ORDER.indexOf(status);
      return index < 0 ? STATUS_ORDER.length : index;
    };
    return entries
      .map((entry) => ({
        ...entry,
        garageVehicles: [entry.identityKey, ...entry.members.map((m) => m.identityKey)]
          .reduce((sum, key) => sum + (perKey.get(key) ?? 0), 0),
      }))
      .sort((a, b) => rank(a.status) - rank(b.status) || b.garageVehicles - a.garageVehicles);
  }

  async history(requestId: string) {
    const [pipeline, audit] = await Promise.all([
      this.pipeline.history(requestId),
      this.prisma.adminAudit.findMany({
        where: { targetEntity: AdminAuditEntity.VEHICLE_IMAGE, targetEntityId: requestId },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: { action: true, actorEmail: true, actorName: true, newValues: true, reason: true, createdAt: true },
      }),
    ]);
    const identityKey = (pipeline as { identityKey?: unknown }).identityKey;
    const backend = typeof identityKey === 'string'
      ? await this.prisma.vehicleImageIdentity.findUnique({
          where: { identityKey },
          select: {
            status: true, reason: true, pipelineStatus: true, imageUrl: true, imageVersion: true,
            catalogAssetKey: true, lastSyncedAt: true, nextSyncAt: true, lastError: true, lastErrorAt: true,
            _count: { select: { vehicles: true } },
          },
        })
      : null;
    return { pipeline, backend, audit };
  }

  preview(candidateId: string) {
    return this.pipeline.preview(candidateId);
  }

  async approve(candidateId: string, dto: ApproveCandidateDto, ctx: AdminContext) {
    const entry = await this.entryFor(candidateId);
    const result = await this.pipeline.approve(candidateId, {
      actor: ctx.actor,
      ...(dto.identityConfirmation ? { identityConfirmation: dto.identityConfirmation } : {}),
      ...(dto.scope ? { scope: dto.scope } : {}),
    });
    await this.record(AdminAuditAction.VEHICLE_IMAGE_APPROVED, entry, ctx, {
      candidateId,
      identityKey: entry.identityKey,
      subjectKey: entry.subjectKey,
      verification: entry.verification,
      identityConfirmation: dto.identityConfirmation ? { ...dto.identityConfirmation } : null,
      scope: dto.scope ? { ...dto.scope } : null,
    });
    const synced = await this.syncAffected(entry, Boolean(dto.scope));
    return { candidate: result, syncedIdentities: synced };
  }

  async reject(candidateId: string, reason: string | undefined, ctx: AdminContext) {
    const entry = await this.entryFor(candidateId);
    const result = await this.pipeline.reject(candidateId, { actor: ctx.actor, reason: reason ?? null });
    await this.record(AdminAuditAction.VEHICLE_IMAGE_REJECTED, entry, ctx, { candidateId, identityKey: entry.identityKey }, reason);
    await this.syncAffected(entry, false);
    return { candidate: result };
  }

  async retry(requestId: string, ctx: AdminContext) {
    const entry = (await this.pipeline.reviewQueue()).find((item) => item.requestId === requestId);
    if (!entry) throw new NotFoundException('No vehicle image request with this id is waiting');
    const job = await this.pipeline.retry(requestId, { actor: ctx.actor });
    await this.record(AdminAuditAction.VEHICLE_IMAGE_RETRIED, entry, ctx, { identityKey: entry.identityKey, jobId: (job as { id?: unknown }).id ?? null });
    return { job };
  }

  async upload(requestId: string, file: { buffer: Buffer; mimetype: string; size: number } | undefined, ctx: AdminContext) {
    if (!file?.buffer?.length) throw new BadRequestException('Attach the image as the "image" field');
    if (!(ALLOWED_IMAGE_MIME as readonly string[]).includes(file.mimetype))
      throw new BadRequestException('Only PNG, JPEG or WebP images are accepted');
    if (file.size > MAX_UPLOAD_BYTES) throw new BadRequestException('The image must be at most 8 MB');
    const entry = (await this.pipeline.reviewQueue()).find((item) => item.requestId === requestId);
    if (!entry) throw new NotFoundException('No vehicle image request with this id is waiting');
    const candidate = await this.pipeline.upload(requestId, {
      contentType: file.mimetype,
      data: file.buffer.toString('base64'),
      actor: ctx.actor,
    });
    await this.record(AdminAuditAction.VEHICLE_IMAGE_UPLOADED, entry, ctx, {
      candidateId: (candidate as { id?: unknown }).id ?? null,
      contentSha256: (candidate as { contentSha256?: unknown }).contentSha256 ?? null,
      size: file.size,
    });
    await this.syncAffected(entry, false);
    return { candidate };
  }

  async reconcileRun(dto: ReconcileDto, ctx: AdminContext) {
    const report = await this.reconcile.run({ apply: dto.apply === true, batchSize: dto.batchSize, maxBatches: 50 });
    if (report.apply) {
      await this.audit.record({
        action: AdminAuditAction.VEHICLE_IMAGE_RECONCILED,
        actor: ctx.actor,
        target: { entity: AdminAuditEntity.VEHICLE_IMAGE, id: report.runId, name: 'Garage identity reconcile' },
        newValues: { scanned: report.scanned, upgraded: report.upgraded, conflicts: report.conflicts, stamp: report.stamp },
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
      });
    }
    return { ...report, changes: report.changes.slice(0, 200) };
  }

  async revert(dto: RevertReconcileDto, ctx: AdminContext) {
    const result = await this.reconcile.revert(dto.runId, dto.apply === true);
    if (dto.apply === true) {
      await this.audit.record({
        action: AdminAuditAction.VEHICLE_IMAGE_RECONCILED,
        actor: ctx.actor,
        target: { entity: AdminAuditEntity.VEHICLE_IMAGE, id: dto.runId, name: 'Garage identity reconcile revert' },
        newValues: { revert: dto.runId, reverted: result.reverted, skipped: result.skipped },
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
      });
    }
    return result;
  }

  /** The queue entry holding a pending candidate; 404 when it is not pending any more. */
  private async entryFor(candidateId: string): Promise<ReviewQueueEntry> {
    const entry = (await this.pipeline.reviewQueue()).find((item) =>
      item.candidates.some((candidate) => candidate.id === candidateId && candidate.status === 'pending'));
    if (!entry) throw new NotFoundException('No pending candidate with this id');
    return entry;
  }

  /**
   * Re-read the Garage identities a decision affects: the subject's own and its
   * members', and with a scope every identity of the same model, since the
   * scope may have taken them over.
   */
  private async syncAffected(entry: ReviewQueueEntry, scoped: boolean): Promise<number> {
    const keys = new Set([entry.identityKey, ...entry.members.map((m) => m.identityKey)]);
    const modelId = (entry.identity as { modelId?: unknown }).modelId;
    if (scoped && typeof modelId === 'string') {
      const sameModel = await this.prisma.vehicleImageIdentity.findMany({
        where: { identity: { path: ['modelId'], equals: modelId } },
        select: { identityKey: true },
        take: 200,
      });
      for (const row of sameModel) keys.add(row.identityKey);
    }
    let synced = 0;
    for (const key of keys) if (await this.delivery.syncNow(key)) synced += 1;
    return synced;
  }

  private record(
    action: AdminAuditAction,
    entry: ReviewQueueEntry,
    ctx: AdminContext,
    newValues: Record<string, unknown>,
    reason?: string,
  ) {
    return this.audit.record({
      action,
      actor: ctx.actor,
      target: { entity: AdminAuditEntity.VEHICLE_IMAGE, id: entry.requestId, name: label(entry) },
      newValues: JSON.parse(JSON.stringify(newValues)) as Prisma.InputJsonValue,
      reason: reason ?? null,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });
  }
}
