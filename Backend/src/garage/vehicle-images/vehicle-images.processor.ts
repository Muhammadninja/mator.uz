import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Job, Queue } from 'bullmq';
import { QUEUE_NAMES, VEHICLE_IMAGE_JOBS } from '../../queue/queue.constants';
import {
  VehicleImageDeliveryService,
  type DispatchJobData,
} from './vehicle-image.delivery.service';
import { VehicleImageReconcileService } from './vehicle-image.reconcile.service';
import { readVehicleImageConfig } from './vehicle-image.config';

export const VEHICLE_IMAGE_RELAY_EVERY_MS = 30_000;
export const VEHICLE_IMAGE_SYNC_EVERY_MS = 60_000;
export const VEHICLE_IMAGE_REVIVE_EVERY_MS = 10 * 60_000;
export const VEHICLE_IMAGE_RECONCILE_EVERY_MS = 15 * 60_000;
const SCHEDULER_IDS = {
  relay: 'vehicle-images-relay',
  sync: 'vehicle-images-sync',
  revive: 'vehicle-images-revive',
  reconcile: 'vehicle-images-reconcile',
} as const;
/** One scheduled reconcile pass touches at most this many vehicles. */
const RECONCILE_BATCH = 200;
const RECONCILE_MAX_BATCHES = 5;

/**
 * Worker for the dedicated `vehicle-images` queue (concurrency 2). Every job
 * checks its flag at run time, so jobs left over from an enabled period do
 * nothing once it is off. The schedulers are registered only while their flag
 * is on and removed when it is off:
 *
 *   relay, sync, revive   VEHICLE_IMAGES_ENABLED (they talk to the pipeline)
 *   reconcile             VEHICLE_IMAGE_RECONCILE_ENABLED (database only; it
 *                         also runs with the pipeline integration off)
 */
@Processor(QUEUE_NAMES.VEHICLE_IMAGES, { concurrency: 2 })
@Injectable()
export class VehicleImagesProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(VehicleImagesProcessor.name);
  private readonly reconcileEnabled: boolean;

  constructor(
    private readonly delivery: VehicleImageDeliveryService,
    private readonly reconcile: VehicleImageReconcileService,
    @InjectQueue(QUEUE_NAMES.VEHICLE_IMAGES) private readonly queue: Queue,
    config: ConfigService,
  ) {
    super();
    this.reconcileEnabled = readVehicleImageConfig((key) => config.get(key)).reconcileEnabled;
  }

  async onModuleInit(): Promise<void> {
    try {
      const template = { opts: { removeOnComplete: true, removeOnFail: 100 } };
      const schedule = async (id: string, every: number, name: string, on: boolean) => {
        if (!on) return this.queue.removeJobScheduler(id);
        await this.queue.upsertJobScheduler(id, { every }, { name, data: {}, ...template });
      };
      const on = this.delivery.enabled;
      await schedule(SCHEDULER_IDS.relay, VEHICLE_IMAGE_RELAY_EVERY_MS, VEHICLE_IMAGE_JOBS.RELAY, on);
      await schedule(SCHEDULER_IDS.sync, VEHICLE_IMAGE_SYNC_EVERY_MS, VEHICLE_IMAGE_JOBS.SYNC, on);
      await schedule(SCHEDULER_IDS.revive, VEHICLE_IMAGE_REVIVE_EVERY_MS, VEHICLE_IMAGE_JOBS.REVIVE, on);
      await schedule(
        SCHEDULER_IDS.reconcile,
        VEHICLE_IMAGE_RECONCILE_EVERY_MS,
        VEHICLE_IMAGE_JOBS.RECONCILE,
        this.reconcileEnabled,
      );
      if (on) this.logger.log('Vehicle image relay, sync and revive scheduled');
      if (this.reconcileEnabled) this.logger.log('Vehicle image reconcile scheduled');
      if (on) await this.logPipelineReadiness();
    } catch (err) {
      this.logger.error(
        `Vehicle image schedulers not registered: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  /** One clear line at boot: is the pipeline reachable, and on the same registry? */
  private async logPipelineReadiness(): Promise<void> {
    const health = await this.delivery.health(true);
    if (health.ready && health.registryMatches) {
      this.logger.log('Vehicle image pipeline ready; registry fingerprints match');
    } else {
      this.logger.error(
        `Vehicle image pipeline NOT usable: ${health.error ?? (health.ready ? 'registry_mismatch' : 'not_ready')} ` +
          '(see GET /v1/admin/vehicle-images/status and scripts/vehicle-images/diagnose-pipeline.mjs)',
      );
    }
  }

  async process(job: Job): Promise<unknown> {
    if (job.name === VEHICLE_IMAGE_JOBS.RECONCILE) {
      if (!this.reconcileEnabled) return { skipped: 'disabled' };
      const report = await this.reconcile.run({
        apply: true,
        batchSize: RECONCILE_BATCH,
        maxBatches: RECONCILE_MAX_BATCHES,
      });
      return { runId: report.runId, scanned: report.scanned, upgraded: report.upgraded, conflicts: report.conflicts };
    }
    if (!this.delivery.enabled) return { skipped: 'disabled' };
    switch (job.name) {
      case VEHICLE_IMAGE_JOBS.DISPATCH:
        return {
          outcome: await this.delivery.dispatch(job.data as DispatchJobData),
        };
      case VEHICLE_IMAGE_JOBS.RELAY:
        return { queued: await this.delivery.relayDue() };
      case VEHICLE_IMAGE_JOBS.SYNC:
        return { synced: await this.delivery.syncDue() };
      case VEHICLE_IMAGE_JOBS.REVIVE:
        return { revived: await this.delivery.reviveStalled() };
      default:
        return { skipped: 'unknown-job' };
    }
  }
}
