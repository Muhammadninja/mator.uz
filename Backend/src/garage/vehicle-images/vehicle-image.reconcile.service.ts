import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { VARIANT_SELECT } from '../vehicles/vehicle.presenter';
import {
  currentIdentityStamp,
  VehicleImagesService,
  type StagedVehicleData,
} from './vehicle-images.service';

/**
 * Re-resolution of saved Garage vehicles.
 *
 * A vehicle's identity is resolved when it is added (or its generation picked)
 * and stamped with the resolver version and registry fingerprint it used
 * (`identity_resolved_with`). When either changes, or for vehicles saved before
 * stamping existed, this job resolves the vehicle again, once per version:
 *
 *   - It only UPGRADES: unresolved → resolved, review → requestable or verified,
 *     unverified → verified. A vehicle that already has a verified identity is
 *     never reassigned (a disagreement is counted for an administrator), and a
 *     vehicle that has an image request is never downgraded to review.
 *   - Writes are optimistic: if the owner changed the vehicle meanwhile, that
 *     vehicle is skipped and retried on the next run.
 *   - Every change is logged with its previous and next values; `revert(runId)`
 *     restores the previous values on vehicles that still hold the next ones.
 *   - Dry run by default: the report says what would change and writes nothing.
 *
 * Vehicles whose image state is shared through an identity row need no work
 * here: when the pipeline approves an identity, every vehicle showing it sees
 * the image on its next read.
 */
export interface ReconcileReport {
  runId: string;
  apply: boolean;
  stamp: string;
  scanned: number;
  upgraded: number;
  unchanged: number;
  keptVerified: number;
  verifiedConflicts: number;
  downgradesSkipped: number;
  conflicts: number;
  catalogUnreadable: number;
  review: Record<string, number>;
  changes: Array<{ vehicleId: string; from: string; to: string }>;
}

export type IdentitySnapshot = Pick<
  StagedVehicleData,
  | 'imageIdentityKey'
  | 'imageReviewReason'
  | 'identityModelId'
  | 'identityGenerationId'
  | 'identityFaceliftId'
  | 'identityMarket'
> & { identityResolvedWith: string | null };

const SNAPSHOT_FIELDS = [
  'imageIdentityKey',
  'imageReviewReason',
  'identityModelId',
  'identityGenerationId',
  'identityFaceliftId',
  'identityMarket',
  'identityResolvedWith',
] as const;

const CANDIDATE_SELECT = {
  id: true,
  year: true,
  trimId: true,
  variantModelId: true,
  imageIdentityKey: true,
  imageReviewReason: true,
  identityModelId: true,
  identityGenerationId: true,
  identityFaceliftId: true,
  identityMarket: true,
  identityResolvedWith: true,
  model: { select: { ...VARIANT_SELECT, variants: { select: VARIANT_SELECT } } },
  trim: { select: { id: true, modelId: true, name: true } },
} satisfies Prisma.VehicleSelect;

type Candidate = Prisma.VehicleGetPayload<{ select: typeof CANDIDATE_SELECT }>;

const snapshotOf = (v: Candidate): IdentitySnapshot => ({
  imageIdentityKey: v.imageIdentityKey,
  imageReviewReason: v.imageReviewReason,
  identityModelId: v.identityModelId,
  identityGenerationId: v.identityGenerationId,
  identityFaceliftId: v.identityFaceliftId,
  identityMarket: v.identityMarket,
  identityResolvedWith: v.identityResolvedWith,
});

const describe = (s: Pick<IdentitySnapshot, 'imageIdentityKey' | 'imageReviewReason' | 'identityMarket' | 'identityModelId'>): string =>
  s.imageReviewReason
    ? `review:${s.imageReviewReason}`
    : s.imageIdentityKey
      ? `${s.identityMarket ? 'verified' : 'unverified'}:${s.identityModelId}:${s.imageIdentityKey.slice(0, 8)}`
      : 'unresolved';

class ConcurrentChange extends Error {}

@Injectable()
export class VehicleImageReconcileService {
  private readonly logger = new Logger(VehicleImageReconcileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly images: VehicleImagesService,
  ) {}

  async run(opts: {
    apply: boolean;
    batchSize?: number;
    maxBatches?: number;
    runId?: string;
  }): Promise<ReconcileReport> {
    const stamp = currentIdentityStamp();
    const report: ReconcileReport = {
      runId: opts.runId ?? `rec_${new Date().toISOString().slice(0, 10)}_${randomUUID().slice(0, 8)}`,
      apply: opts.apply,
      stamp,
      scanned: 0,
      upgraded: 0,
      unchanged: 0,
      keptVerified: 0,
      verifiedConflicts: 0,
      downgradesSkipped: 0,
      conflicts: 0,
      catalogUnreadable: 0,
      review: {},
      changes: [],
    };
    const batchSize = Math.min(Math.max(opts.batchSize ?? 200, 1), 1000);
    const maxBatches = Math.max(opts.maxBatches ?? 1000, 1);
    let cursor = '';
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const vehicles = await this.prisma.vehicle.findMany({
        where: {
          deletedAt: null,
          id: { gt: cursor },
          OR: [{ identityResolvedWith: null }, { identityResolvedWith: { not: stamp } }],
        },
        orderBy: { id: 'asc' },
        take: batchSize,
        select: CANDIDATE_SELECT,
      });
      if (vehicles.length === 0) break;
      for (const vehicle of vehicles) {
        cursor = vehicle.id;
        report.scanned += 1;
        await this.reconcileOne(vehicle, report);
      }
    }
    this.logger.log(
      `vehicle-image reconcile ${report.runId} (${opts.apply ? 'apply' : 'dry run'}): ` +
        `scanned ${report.scanned}, upgraded ${report.upgraded}, unchanged ${report.unchanged}, ` +
        `kept verified ${report.keptVerified}, conflicts ${report.conflicts}`,
    );
    return report;
  }

  private async reconcileOne(v: Candidate, report: ReconcileReport): Promise<void> {
    const plan = await this.images.planFor({
      year: v.year,
      model: v.model,
      trim: v.trim,
      chosenVariantId: v.variantModelId,
    });
    if (!plan) {
      // Catalog unreadable: not stamped, so the next run tries again.
      report.catalogUnreadable += 1;
      return;
    }
    const previous = snapshotOf(v);
    const verified = Boolean(v.identityModelId && v.identityMarket && !v.imageReviewReason);
    if (verified) {
      report.keptVerified += 1;
      if (plan.kind !== 'request' || plan.identityKey !== v.imageIdentityKey) report.verifiedConflicts += 1;
      await this.stampOnly(v, report);
      return;
    }
    if (plan.kind === 'review') {
      report.review[plan.reason] = (report.review[plan.reason] ?? 0) + 1;
      if (v.imageIdentityKey && !v.imageReviewReason) {
        report.downgradesSkipped += 1;
        await this.stampOnly(v, report);
        return;
      }
      if (v.imageReviewReason === plan.reason) {
        report.unchanged += 1;
        await this.stampOnly(v, report);
        return;
      }
    } else if (
      plan.identityKey === v.imageIdentityKey &&
      v.imageReviewReason === null &&
      (plan.resolved?.modelId ?? null) === v.identityModelId &&
      (plan.resolved?.marketRegion ?? null) === v.identityMarket
    ) {
      report.unchanged += 1;
      await this.stampOnly(v, report);
      return;
    }

    if (!report.apply) {
      report.upgraded += 1;
      report.changes.push({
        vehicleId: v.id,
        from: describe(previous),
        to: plan.kind === 'review'
          ? `review:${plan.reason}`
          : `${plan.verification ?? 'verified'}:${plan.identity.modelId}:${plan.identityKey.slice(0, 8)}`,
      });
      return;
    }
    let outboxId: string | null = null;
    try {
      await this.prisma.$transaction(async (tx) => {
        const staged = await this.images.stage(tx, v.id, plan);
        const next = staged.data as StagedVehicleData;
        const updated = await tx.vehicle.updateMany({
          where: {
            id: v.id,
            deletedAt: null,
            imageIdentityKey: v.imageIdentityKey,
            imageReviewReason: v.imageReviewReason,
            identityResolvedWith: v.identityResolvedWith,
          },
          data: next,
        });
        if (updated.count !== 1) throw new ConcurrentChange();
        await tx.vehicleImageReconcileLog.create({
          data: {
            runId: report.runId,
            vehicleId: v.id,
            previous: previous as unknown as Prisma.InputJsonValue,
            next: pick(next) as unknown as Prisma.InputJsonValue,
          },
        });
        outboxId = staged.outboxId;
        report.changes.push({ vehicleId: v.id, from: describe(previous), to: describe(pick(next)) });
      });
      report.upgraded += 1;
      this.images.kick(outboxId);
    } catch (err) {
      if (!(err instanceof ConcurrentChange)) throw err;
      report.conflicts += 1;
    }
  }

  private async stampOnly(v: Candidate, report: ReconcileReport): Promise<void> {
    if (!report.apply) return;
    await this.prisma.vehicle.updateMany({
      where: { id: v.id, identityResolvedWith: v.identityResolvedWith },
      data: { identityResolvedWith: report.stamp },
    });
  }

  /**
   * Undo one run: restore the previous identity on every vehicle that still holds
   * the identity the run gave it. Vehicles changed since are left alone.
   */
  async revert(runId: string, apply: boolean): Promise<{ runId: string; logged: number; reverted: number; skipped: number }> {
    const rows = await this.prisma.vehicleImageReconcileLog.findMany({
      where: { runId },
      orderBy: { id: 'desc' },
    });
    let reverted = 0;
    let skipped = 0;
    for (const row of rows) {
      const next = row.next as unknown as IdentitySnapshot;
      const previous = row.previous as unknown as IdentitySnapshot;
      if (!apply) {
        const current = await this.prisma.vehicle.findFirst({
          where: { id: row.vehicleId, imageIdentityKey: next.imageIdentityKey, imageReviewReason: next.imageReviewReason },
          select: { id: true },
        });
        if (current) reverted += 1;
        else skipped += 1;
        continue;
      }
      // The previous identity comes back, but keeps the run's stamp: the vehicle
      // counts as evaluated for this version, so the next pass does not redo it.
      const result = await this.prisma.vehicle.updateMany({
        where: {
          id: row.vehicleId,
          imageIdentityKey: next.imageIdentityKey,
          imageReviewReason: next.imageReviewReason,
          identityModelId: next.identityModelId,
        },
        data: { ...pick(previous), identityResolvedWith: next.identityResolvedWith },
      });
      if (result.count === 1) reverted += 1;
      else skipped += 1;
    }
    return { runId, logged: rows.length, reverted, skipped };
  }
}

function pick(source: Partial<IdentitySnapshot>): IdentitySnapshot {
  const out = {} as Record<string, unknown>;
  for (const field of SNAPSHOT_FIELDS) out[field] = source[field] ?? null;
  return out as IdentitySnapshot;
}
