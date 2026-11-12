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
  planVehicleIdentity,
  type IdentityPlan,
  type VehicleIdentitySource,
} from './vehicle-image.identity';
import { REDISPATCHABLE_REASONS } from './vehicle-image.state';
import {
  dispatchJob,
  VehicleImageDeliveryService,
} from './vehicle-image.delivery.service';

export interface StagedVehicleImage {
  /** Spread into the `vehicles` row being created. */
  data: { imageIdentityKey?: string; imageReviewReason?: string };
  /** Outbox row written in this transaction, to be kicked after commit. */
  outboxId: string | null;
}

const NOTHING: StagedVehicleImage = { data: {}, outboxId: null };

/**
 * Garage side of the vehicle image integration: the three steps of
 * VehiclesService.create (prepare → stage inside the transaction → kick after
 * commit) and the status refresh. Nothing here can make a Garage create fail
 * because of the pipeline. The pipeline is only called by the queue, and `kick`
 * is fire-and-forget.
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
   * ambiguity check). Null when the integration is off, or when the catalog
   * could not be read; the vehicle is still created.
   */
  async prepare(input: {
    year: number;
    model: VehicleIdentitySource['model'];
    trim: VehicleIdentitySource['trim'];
  }): Promise<IdentityPlan | null> {
    if (!this.delivery.enabled || !input.model) return null;
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
      return planVehicleIdentity({
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
   * Request only when nobody has: a new identity, or one whose earlier request
   * never reached the pipeline. Approved identities are reused at once. Failed
   * and rejected ones are NOT re-requested (no automatic regeneration).
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
      return { data: { imageReviewReason: plan.reason }, outboxId: null };
    }

    const { identityKey } = plan;
    await tx.vehicleImageIdentity.createMany({
      data: [
        {
          identityKey,
          identity: plan.identity as unknown as Prisma.InputJsonValue,
          display: plan.display as unknown as Prisma.InputJsonValue,
        },
      ],
      skipDuplicates: true,
    });
    const state = await tx.vehicleImageIdentity.findUniqueOrThrow({
      where: { identityKey },
      select: { status: true, reason: true, lastSyncedAt: true },
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
      state.status === VehicleImageStatus.UNAVAILABLE &&
      state.reason !== null &&
      REDISPATCHABLE_REASONS.has(state.reason)
    ) {
      const reset = await tx.vehicleImageIdentity.updateMany({
        where: {
          identityKey,
          status: VehicleImageStatus.UNAVAILABLE,
          reason: state.reason,
        },
        data: {
          status: VehicleImageStatus.PENDING,
          reason: null,
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
    return { data: { imageIdentityKey: identityKey }, outboxId };
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
