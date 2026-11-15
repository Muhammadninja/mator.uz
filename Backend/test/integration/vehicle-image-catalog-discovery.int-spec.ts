/**
 * Real catalog backfill against disposable PostgreSQL and a namespaced real
 * BullMQ queue. Set TEST_DATABASE_URL (localhost, *_test/*_it/*_audit) and
 * TEST_REDIS_HOST/TEST_REDIS_PORT to run. Does not need a running Pipeline.
 */
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { VehicleImageCatalogDiscoveryTrigger } from '@prisma/client';
import {
  describeWithDb,
  integrationDatabaseUrl,
  integrationPrisma,
} from '../utils/integration-db';
import { QUEUE_NAMES } from '../../src/queue/queue.constants';
import { VehicleImagePipelineClient } from '../../src/garage/vehicle-images/vehicle-image.pipeline-client';
import { VehicleImageDeliveryService } from '../../src/garage/vehicle-images/vehicle-image.delivery.service';
import { VehicleImagesService } from '../../src/garage/vehicle-images/vehicle-images.service';
import { VehicleImageCatalogDiscoveryService } from '../../src/garage/vehicle-images/vehicle-image.catalog-discovery.service';

const enabled = process.env.VEHICLE_IMAGE_CATALOG_DISCOVERY_E2E === '1';
const describeDiscovery =
  enabled && integrationDatabaseUrl() ? describeWithDb : describe.skip;

describeDiscovery('catalog discovery with PostgreSQL and BullMQ/Redis', () => {
  jest.setTimeout(60_000);
  const prisma = integrationDatabaseUrl()
    ? integrationPrisma()
    : (null as unknown as ReturnType<typeof integrationPrisma>);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const queue = (enabled && integrationDatabaseUrl()
    ? new Queue(QUEUE_NAMES.VEHICLE_IMAGES, {
        connection: {
          host: process.env.TEST_REDIS_HOST ?? '127.0.0.1',
          port: Number(process.env.TEST_REDIS_PORT ?? 6379),
          ...(process.env.TEST_REDIS_PASSWORD
            ? { password: process.env.TEST_REDIS_PASSWORD }
            : {}),
        },
        prefix: `mator-catalog-discovery-test-${suffix}`,
      })
    : null) as unknown as Queue;
  const config = new ConfigService({
    VEHICLE_IMAGES_ENABLED: 'true',
    VEHICLE_IMAGE_PIPELINE_URL: 'http://127.0.0.1:1',
    VEHICLE_IMAGE_REQUEST_TOKEN: 'i'.repeat(40),
    VEHICLE_IMAGE_CATALOG_DISCOVERY_ENABLED: 'true',
  });
  const client = new VehicleImagePipelineClient(config);
  const delivery = new VehicleImageDeliveryService(
    prisma as never,
    client,
    queue,
  );
  const images = new VehicleImagesService(prisma as never, delivery, queue);
  const discovery = new VehicleImageCatalogDiscoveryService(
    prisma as never,
    images,
    delivery,
    config,
  );
  const makeId = `chevrolet-${suffix}`;
  const onixId = `onix-${suffix}`;
  const trackerId = `tracker-${suffix}`;
  const trackerGenerationId = `tracker-gen3-${suffix}`;
  const trackerUnknownGenerationId = `tracker-gen4-${suffix}`;

  beforeAll(async () => {
    await prisma.vehicleMake.create({
      data: { id: makeId, name: 'Chevrolet', isActive: true },
    });
    await prisma.vehicleModelRef.create({
      data: {
        id: onixId,
        makeId,
        name: 'Onix',
        yearFrom: 2020,
        yearTo: 2024,
        bodyType: 'Sedan',
      },
    });
    await prisma.vehicleModelRef.create({
      data: {
        id: trackerId,
        makeId,
        name: 'Tracker',
        yearFrom: 2020,
        yearTo: 2025,
        bodyType: 'SUV',
      },
    });
    await prisma.vehicleModelRef.create({
      data: {
        id: trackerGenerationId,
        makeId,
        name: 'Tracker Gen 3',
        yearFrom: 2020,
        yearTo: 2022,
        bodyType: 'SUV',
        variantOfModelId: trackerId,
      },
    });
    await prisma.vehicleModelRef.create({
      data: {
        id: trackerUnknownGenerationId,
        makeId,
        name: 'Tracker Gen 4',
        yearFrom: 2023,
        yearTo: null,
        bodyType: 'SUV',
        variantOfModelId: trackerId,
      },
    });
    await queue.waitUntilReady();
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    await prisma.vehicleMake.deleteMany({ where: { id: makeId } });
    await prisma.$disconnect();
  });

  it('discovers a new model, schedules one request per valid identity, and flags an incomplete generation', async () => {
    const first = await discovery.run({
      trigger: VehicleImageCatalogDiscoveryTrigger.BACKFILL,
    });
    const scheduled = await prisma.vehicleImageOutbox.findMany({
      where: { identity: { identity: { path: ['makeId'], equals: makeId } } },
      include: { identity: true },
    });
    const jobs = await queue.getJobs([
      'waiting',
      'delayed',
      'active',
      'completed',
      'failed',
    ]);
    const onix = await prisma.vehicleImageCatalogDiscovery.findUnique({
      where: { sourceKey: `${makeId}:${onixId}:model` },
    });
    const unknownGeneration =
      await prisma.vehicleImageCatalogDiscovery.findUnique({
        where: {
          sourceKey: `${makeId}:${trackerId}:generation:${trackerUnknownGenerationId}`,
        },
      });

    expect(first.scheduled).toBeGreaterThanOrEqual(2);
    expect(onix?.identityKey).toMatch(/^[a-f0-9]{64}$/);
    expect(unknownGeneration).toMatchObject({
      status: 'REVIEW_REQUIRED',
      reason: 'generation_year_range_missing',
    });
    expect(scheduled.length).toBeGreaterThanOrEqual(2);
    expect(
      jobs.filter((job) => job.name === 'dispatch').length,
    ).toBeGreaterThanOrEqual(2);

    const second = await discovery.run({
      trigger: VehicleImageCatalogDiscoveryTrigger.SCHEDULED,
    });
    const afterJobs = await queue.getJobs([
      'waiting',
      'delayed',
      'active',
      'completed',
      'failed',
    ]);
    expect(second.scheduled).toBe(0);
    expect(afterJobs.filter((job) => job.name === 'dispatch')).toHaveLength(
      jobs.filter((job) => job.name === 'dispatch').length,
    );
  });
});
