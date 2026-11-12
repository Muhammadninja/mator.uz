// DI wiring check for Phase 3E. The unit specs build the vehicle-image classes
// by hand; this proves the Nest container can construct them from their declared
// constructor metadata. Infrastructure (Prisma, the BullMQ queue, Config,
// realtime, notifications) is supplied as values so nothing dials Redis or a DB.
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { VehiclesService } from './vehicles/vehicles.service';
import { VehiclesController } from './vehicles/vehicles.controller';
import { VehicleImagePipelineClient } from './vehicle-images/vehicle-image.pipeline-client';
import { VehicleImageDeliveryService } from './vehicle-images/vehicle-image.delivery.service';
import { VehicleImagesService } from './vehicle-images/vehicle-images.service';
import { VehicleImagesProcessor } from './vehicle-images/vehicle-images.processor';

async function build(env: Record<string, string> = {}) {
  const queue = {
    add: jest.fn(),
    addBulk: jest.fn(),
    upsertJobScheduler: jest.fn(),
    removeJobScheduler: jest.fn(),
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [VehiclesController],
    providers: [
      VehiclesService,
      VehicleImagePipelineClient,
      VehicleImageDeliveryService,
      VehicleImagesService,
      VehicleImagesProcessor,
      { provide: ConfigService, useValue: new ConfigService(env) },
      { provide: PrismaService, useValue: {} },
      { provide: RealtimeGateway, useValue: { emitGarageEvent: jest.fn() } },
      { provide: NotificationsService, useValue: { emit: jest.fn() } },
      { provide: getQueueToken(QUEUE_NAMES.VEHICLE_IMAGES), useValue: queue },
    ],
  }).compile();
  return { moduleRef, queue };
}

describe('GarageModule DI wiring (vehicle images)', () => {
  it('constructs the Garage service with the vehicle-image chain', async () => {
    const { moduleRef } = await build();
    const vehicles = moduleRef.get(VehiclesService);
    expect((vehicles as unknown as { images: unknown }).images).toBeInstanceOf(
      VehicleImagesService,
    );
    const delivery = moduleRef.get(VehicleImageDeliveryService);
    expect((delivery as unknown as { client: unknown }).client).toBeInstanceOf(
      VehicleImagePipelineClient,
    );
    expect(moduleRef.get(VehicleImagesProcessor)).toBeInstanceOf(
      VehicleImagesProcessor,
    );
    await moduleRef.close();
  });

  it('disabled by default: init removes the schedulers and registers none', async () => {
    const { moduleRef, queue } = await build();
    await moduleRef.get(VehicleImagesProcessor).onModuleInit();
    expect(moduleRef.get(VehicleImagePipelineClient).enabled).toBe(false);
    expect(queue.removeJobScheduler).toHaveBeenCalledTimes(2);
    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    await moduleRef.close();
  });

  it('enabled: init registers the relay and sync schedulers', async () => {
    const { moduleRef, queue } = await build({
      VEHICLE_IMAGES_ENABLED: 'true',
      VEHICLE_IMAGE_PIPELINE_URL: 'http://127.0.0.1:8047',
      VEHICLE_IMAGE_REQUEST_TOKEN: 't'.repeat(40),
    });
    await moduleRef.get(VehicleImagesProcessor).onModuleInit();
    expect(queue.upsertJobScheduler.mock.calls.map((c) => c[0])).toEqual([
      'vehicle-images-relay',
      'vehicle-images-sync',
    ]);
    await moduleRef.close();
  });
});
