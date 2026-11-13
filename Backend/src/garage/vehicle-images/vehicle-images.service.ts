import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import {
  Prisma,
  VehicleImageOutboxStatus,
  VehicleImageStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { IdPrefix, prefixedId } from '../../common/ulid.util';
import { QUEUE_NAMES } from '../../queue/queue.constants';
import {
  type IdentityPlan,
  type ImageReviewReason,
  type ResolvedVehicleIdentity,
  type VehicleIdentitySource,
} from './vehicle-image.identity';
import { planVehicleImage } from './vehicle-image.resolution';
import { isApprovedCatalogAssetKey } from './vehicle-image.catalog';
import {
  IDENTITY_REASONS,
  REDISPATCHABLE_REASONS,
} from './vehicle-image.state';
import {
  dispatchJob,
  VehicleImageDeliveryService,
} from './vehicle-image.delivery.service';

/** The vehicle's identity snapshot and image link, spread into its row. */
export interface StagedVehicleData {
  imageIdentityKey: string | null;
  imageReviewReason: string | null;
  identityModelId: string | null;
  identityGenerationId: string | null;
  identityFaceliftId: string | null;
  identityMarket: string | null;
}

export interface StagedVehicleImage {
  /** Spread into the `vehicles` row being written; empty when nothing was planned. */
  data: Partial<StagedVehicleData>;
  /** Outbox row written in this transaction, to be kicked after commit. */
  outboxId: string | null;
}

const NOTHING: StagedVehicleImage = { data: {}, outboxId: null };

const snapshot = (
  resolved: ResolvedVehicleIdentity | undefined,
): Omit<StagedVehicleData, 'imageIdentityKey' | 'imageReviewReason'> => ({
  identityModelId: resolved?.modelId ?? null,
  identityGenerationId: resolved?.generationId ?? null,
  identityFaceliftId: resolved?.faceliftId ?? null,
  identityMarket: resolved?.marketRegion ?? null,
});

/** An approved registry image: needs no pipeline, and the sync never touches it. */
const catalogState = (assetKey: string) => ({
  status: VehicleImageStatus.APPROVED,
  reason: null,
  imageUrl: null,
  imageVersion: 1,
  catalogAssetKey: assetKey,
  lastSyncedAt: null,
  nextSyncAt: null,
});

/**
 * Garage side of the vehicle image integration: the three steps of
 * VehiclesService.create (prepare → stage inside the transaction → kick after
 * commit) and the status refresh. Nothing here can make a Garage create fail
 * because of the pipeline. The pipeline is only called by the queue, and `kick`
 * is fire-and-forget.
 *
 * Identity resolution and the approved registry image do not depend on the
 * pipeline integration: every new vehicle gets its identity saved, and an
 * approved registry image is used at once. VEHICLE_IMAGES_ENABLED only decides
 * whether an identity WITHOUT an approved image is sent to the pipeline.
 */
@Injectable()
export class VehicleImagesService {
  private readonly logger = new Logger(VehicleImagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly delivery: VehicleImageDeliveryService,
    @InjectQueue(QUEUE_NAMES.VEHICLE_IMAGES) private readonly queue: Queue,
  ) {}

  /**
   * Before the transaction: the canonical identity from existing catalog tables
   * (make, model, the picked trim, and the make's other model names for the
   * ambiguity check) and the verified vehicle image registry (market, generation,
   * facelift, approved image). Null only when the catalog could not be read; the
   * vehicle is still created.
   *
   * `model` is the catalog row the picture is of: the vehicle's own model, or the
   * generation-specific row its generation resolved to. `review` keeps the
   * vehicle on the placeholder without asking the pipeline.
   */
  async prepare(input: {
    year: number;
    model: VehicleIdentitySource['model'];
    trim: VehicleIdentitySource['trim'];
    review?: ImageReviewReason;
  }): Promise<IdentityPlan | null> {
    if (input.review) return { kind: 'review', reason: input.review };
    if (!input.model) return null;
    try {
      const [make, siblings] = await Promise.all([
        this.prisma.vehicleMake.findUnique({
          where: { id: input.model.makeId },
          select: { id: true, name: true },
        }),
        this.prisma.vehicleModelRef.findMany({
          where: { makeId: input.model.makeId, id: { not: input.model.id } },
          select: { name: true },
        }),
      ]);
      return planVehicleImage({
        year: input.year,
        make: make ?? null,
        model: input.model,
        trim: input.trim,
        siblingModelNames: siblings.map((s) => s.name),
      });
    } catch (err) {
      this.logger.warn(
        `vehicle-image prepare skipped: ${(err as Error)?.name ?? 'error'}`,
      );
      return null;
    }
  }

  /**
   * Inside the Garage create transaction: record the identity and, when the
   * pipeline must be asked, write the outbox row, so the request is never lost
   * and never sent for a vehicle that was rolled back.
   *
   * Image priority: (1/2) an approved registry image, exact or compatible, wins
   * over any other state of the identity and needs no pipeline; (3) an approved
   * pipeline publication already on the identity is reused; (4) otherwise the
   * placeholder, with one pipeline request when the integration is on.
   *
   * Request only when nobody has: a new identity, or one whose earlier request
   * never reached the pipeline (or was never sent while the integration was
   * off). Approved identities are reused at once. Failed and rejected ones are
   * NOT re-requested (no automatic regeneration).
   */
  async stage(
    tx: Prisma.TransactionClient,
    vehicleId: string,
    plan: IdentityPlan | null,
  ): Promise<StagedVehicleImage> {
    if (!plan) return NOTHING;
    if (plan.kind === 'review') {
      this.logger.warn(
        `vehicle-image review: vehicle ${vehicleId} kept on placeholder (${plan.reason})`,
      );
      return {
        data: {
          imageIdentityKey: null,
          imageReviewReason: plan.reason,
          ...snapshot(undefined),
        },
        outboxId: null,
      };
    }

    const { identityKey } = plan;
    const data: StagedVehicleData = {
      imageIdentityKey: identityKey,
      imageReviewReason: null,
      ...snapshot(plan.resolved),
    };
    const assetKey = plan.catalogAsset?.assetKey ?? null;
    const enabled = this.delivery.enabled;
    await tx.vehicleImageIdentity.createMany({
      data: [
        {
          identityKey,
          identity: plan.identity as unknown as Prisma.InputJsonValue,
          display: plan.display as unknown as Prisma.InputJsonValue,
          ...(assetKey
            ? catalogState(assetKey)
            : enabled
              ? {}
              : {
                  status: VehicleImageStatus.UNAVAILABLE,
                  reason: IDENTITY_REASONS.NOT_REQUESTED,
                }),
        },
      ],
      skipDuplicates: true,
    });
    if (assetKey) {
      await tx.vehicleImageIdentity.update({
        where: { identityKey },
        data: catalogState(assetKey),
      });
      return { data, outboxId: null };
    }
    if (!enabled) return { data, outboxId: null };

    const state = await tx.vehicleImageIdentity.findUniqueOrThrow({
      where: { identityKey },
      select: {
        status: true,
        reason: true,
        lastSyncedAt: true,
        catalogAssetKey: true,
      },
    });

    let request = false;
    if (
      state.status === VehicleImageStatus.PENDING &&
      state.lastSyncedAt === null
    ) {
      const open = await tx.vehicleImageOutbox.findFirst({
        where: { identityKey, status: VehicleImageOutboxStatus.PENDING },
        select: { id: true },
      });
      request = !open;
    } else if (
      // Never sent, lost by the pipeline, or a registry image whose approval
      // was withdrawn since: ask the pipeline (once).
      (state.status === VehicleImageStatus.UNAVAILABLE &&
        state.reason !== null &&
        REDISPATCHABLE_REASONS.has(state.reason)) ||
      (state.status === VehicleImageStatus.APPROVED &&
        state.catalogAssetKey !== null &&
        !isApprovedCatalogAssetKey(state.catalogAssetKey))
    ) {
      const reset = await tx.vehicleImageIdentity.updateMany({
        where: {
          identityKey,
          status: state.status,
          reason: state.reason,
          catalogAssetKey: state.catalogAssetKey,
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
      request = reset.count > 0;
    }

    let outboxId: string | null = null;
    if (request) {
      const id = prefixedId(IdPrefix.VEHICLE_IMAGE_OUTBOX);
      // The partial unique index keeps one PENDING row per identity under races.
      const created = await tx.vehicleImageOutbox.createMany({
        data: [{ id, identityKey, availableAt: new Date() }],
        skipDuplicates: true,
      });
      if (created.count === 1) outboxId = id;
    }
    return { data, outboxId };
  }

  /** After commit: queue the first attempt now. If Redis is down, the relay sends it later. */
  kick(outboxId: string | null): void {
    if (!outboxId) return;
    const job = dispatchJob(outboxId, 0);
    void this.queue.add(job.name, job.data, job.opts).catch((err: unknown) => {
      this.logger.warn(
        `vehicle-image enqueue deferred to relay: ${(err as Error)?.name ?? 'error'}`,
      );
    });
  }

  /** Best-effort pipeline refresh for the status endpoint (bounded, never throws). */
  refresh(identityKey: string | null): Promise<void> {
    return identityKey ? this.delivery.refresh(identityKey) : Promise.resolve();
  }
}
