import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import { QUEUE_NAMES, VEHICLE_IMAGE_JOBS } from '../../queue/queue.constants';
import {
  VehicleImageDeliveryService,
  type DispatchJobData,
} from './vehicle-image.delivery.service';

export const VEHICLE_IMAGE_RELAY_EVERY_MS = 30_000;
export const VEHICLE_IMAGE_SYNC_EVERY_MS = 60_000;
const SCHEDULER_IDS = {
  relay: 'vehicle-images-relay',
  sync: 'vehicle-images-sync',
} as const;

/**
 * Worker for the dedicated `vehicle-images` queue. Every job checks the flag at
 * run time, so jobs left over from an enabled period do nothing once it is off.
 * The schedulers are registered only while enabled and removed when disabled.
 */
@Processor(QUEUE_NAMES.VEHICLE_IMAGES, { concurrency: 2 })
@Injectable()
export class VehicleImagesProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(VehicleImagesProcessor.name);

  constructor(
    private readonly delivery: VehicleImageDeliveryService,
    @InjectQueue(QUEUE_NAMES.VEHICLE_IMAGES) private readonly queue: Queue,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    try {
      if (!this.delivery.enabled) {
        await this.queue.removeJobScheduler(SCHEDULER_IDS.relay);
        await this.queue.removeJobScheduler(SCHEDULER_IDS.sync);
        return;
      }
      const template = { opts: { removeOnComplete: true, removeOnFail: 100 } };
      await this.queue.upsertJobScheduler(
        SCHEDULER_IDS.relay,
        { every: VEHICLE_IMAGE_RELAY_EVERY_MS },
        { name: VEHICLE_IMAGE_JOBS.RELAY, data: {}, ...template },
      );
      await this.queue.upsertJobScheduler(
        SCHEDULER_IDS.sync,
        { every: VEHICLE_IMAGE_SYNC_EVERY_MS },
        { name: VEHICLE_IMAGE_JOBS.SYNC, data: {}, ...template },
      );
      this.logger.log('Vehicle image relay and sync scheduled');
    } catch (err) {
      this.logger.error(
        `Vehicle image schedulers not registered: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  async process(job: Job): Promise<unknown> {
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
      default:
        return { skipped: 'unknown-job' };
    }
  }
}
