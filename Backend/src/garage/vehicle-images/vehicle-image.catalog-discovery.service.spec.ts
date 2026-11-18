import { ConfigService } from '@nestjs/config';
import {
  VehicleImageCatalogDiscoveryTrigger,
  VehicleImageCatalogDiscoveryStatus,
} from '@prisma/client';
import { VehicleImageCatalogDiscoveryService } from './vehicle-image.catalog-discovery.service';
import type { IdentityPlan } from './vehicle-image.identity';
import type { VariantRow } from '../vehicles/vehicle-generation';

const plan = (modelId: string): IdentityPlan => ({
  kind: 'request',
  verification: 'unverified',
  identity: {
    makeId: 'chevrolet',
    modelId,
    modelYear: 2020,
    generationId: null,
    faceliftId: null,
    bodyType: 'SUV',
    trimId: null,
    identityStatus: 'unverified',
  },
  display: { manufacturer: 'Chevrolet', model: modelId },
  identityKey: modelId.padEnd(64, '0'),
});

function setup() {
  const onix = {
    id: 'onix',
    makeId: 'chevrolet',
    name: 'Onix',
    yearFrom: 2019,
    yearTo: 2022,
    bodyType: 'Hatchback',
    variants: [] as VariantRow[],
  };
  const tracker = {
    id: 'tracker-auto',
    makeId: 'chevrolet',
    name: 'Tracker',
    yearFrom: 2020,
    yearTo: 2024,
    bodyType: 'SUV',
    variants: [] as VariantRow[],
  };
  const make = { id: 'chevrolet', name: 'Chevrolet', models: [onix, tracker] };
  const prisma: any = {
    vehicleImageCatalogDiscoveryRun: {
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    vehicleImageCatalogDiscovery: {
      upsert: jest.fn().mockResolvedValue({}),
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
    },
    vehicleMake: { findMany: jest.fn().mockResolvedValue([make]) },
    vehicleImageIdentity: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ status: 'PENDING', catalogAssetKey: null }),
    },
    $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn({})),
  };
  const images: any = {
    prepare: jest.fn(async ({ model }: { model: { id: string } }) =>
      plan(model.id),
    ),
    planFor: jest.fn(async ({ chosenVariantId }: { chosenVariantId: string }) =>
      plan(chosenVariantId),
    ),
    stage: jest.fn().mockResolvedValue({ outboxId: null }),
    kick: jest.fn(),
  };
  const delivery: any = { enabled: true };
  const config = new ConfigService({
    VEHICLE_IMAGES_ENABLED: 'true',
    VEHICLE_IMAGE_PIPELINE_URL: 'https://pipeline.test',
    VEHICLE_IMAGE_REQUEST_TOKEN: 't'.repeat(40),
    VEHICLE_IMAGE_CATALOG_DISCOVERY_ENABLED: 'true',
  });
  return {
    service: new VehicleImageCatalogDiscoveryService(
      prisma,
      images,
      delivery,
      config,
    ),
    prisma,
    images,
    make,
  };
}

describe('VehicleImageCatalogDiscoveryService', () => {
  it('scans Onix and Tracker repeatedly without rescheduling identities already in the outbox', async () => {
    const { service, prisma, images } = setup();
    images.stage
      .mockResolvedValueOnce({ outboxId: 'outbox-onix' })
      .mockResolvedValueOnce({ outboxId: 'outbox-tracker' })
      .mockResolvedValue({ outboxId: null });
    const first = await service.run({
      trigger: VehicleImageCatalogDiscoveryTrigger.BACKFILL,
    });
    const second = await service.run({
      trigger: VehicleImageCatalogDiscoveryTrigger.SCHEDULED,
    });
    expect(first).toMatchObject({ scanned: 2, scheduled: 2 });
    expect(second).toMatchObject({ scanned: 2, scheduled: 0, existing: 2 });
    expect(
      images.kick.mock.calls.filter(([id]: [string | null]) => id !== null),
    ).toHaveLength(2);
    expect(prisma.vehicleImageCatalogDiscovery.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sourceKey: 'chevrolet:onix:model' },
      }),
    );
  });

  it('routes a generation without its production range for review', async () => {
    const { service, prisma, images, make } = setup();
    make.models[1].variants = [
      {
        id: 'tracker-gen4',
        makeId: 'chevrolet',
        name: 'Tracker Gen 4',
        yearFrom: 2023,
        yearTo: null,
        bodyType: 'SUV',
      },
    ];
    const result = await service.run({
      trigger: VehicleImageCatalogDiscoveryTrigger.ADMIN,
    });
    expect(result.reviewRequired).toBe(1);
    expect(images.planFor).not.toHaveBeenCalled();
    expect(prisma.vehicleImageCatalogDiscovery.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: VehicleImageCatalogDiscoveryStatus.REVIEW_REQUIRED,
          reason: 'generation_year_range_missing',
        }),
      }),
    );
  });

  it('uses an existing single-generation catalog year without manufacturing a production range', async () => {
    const { service, images, make } = setup();
    Object.assign(make.models[1], {
      id: 'tracker',
      yearFrom: null,
      yearTo: null,
    });
    images.stage.mockResolvedValue({ outboxId: 'tracker-private-candidate' });
    const result = await service.run({
      trigger: VehicleImageCatalogDiscoveryTrigger.SCHEDULED,
    });
    expect(result.scheduled).toBe(2);
    expect(images.prepare).toHaveBeenCalledWith({
      year: 2020,
      model: expect.objectContaining({
        id: 'tracker',
        yearFrom: null,
        yearTo: null,
      }),
      trim: null,
    });
    expect(make.models[1]).toMatchObject({ yearFrom: null, yearTo: null });
    expect(images.planFor).not.toHaveBeenCalled();
  });

  it('does not pick a generation or invent years for multi-generation and unknown models', async () => {
    const { service, images, prisma, make } = setup();
    Object.assign(make.models[0], {
      id: 'malibu',
      yearFrom: null,
      yearTo: null,
    });
    Object.assign(make.models[1], {
      id: 'unknown-model',
      yearFrom: null,
      yearTo: null,
    });
    const result = await service.run({
      trigger: VehicleImageCatalogDiscoveryTrigger.SCHEDULED,
    });
    expect(result.reviewRequired).toBe(2);
    expect(images.prepare).not.toHaveBeenCalled();
    expect(images.stage).not.toHaveBeenCalled();
    const reasons = prisma.vehicleImageCatalogDiscovery.upsert.mock.calls.map(
      ([input]: any[]) => input.create.reason,
    );
    expect(reasons).toEqual([
      'model_generation_selection_required',
      'model_year_range_missing',
    ]);
  });

  it('routes every overlapping generation to review, including inclusive boundary years', async () => {
    const { service, images, prisma, make } = setup();
    Object.assign(make.models[1], {
      variants: [
        {
          id: 'nexia-1',
          makeId: 'chevrolet',
          name: 'Nexia 1',
          yearFrom: 1996,
          yearTo: 2008,
          bodyType: null,
        },
        {
          id: 'nexia-2',
          makeId: 'chevrolet',
          name: 'Nexia 2',
          yearFrom: 2008,
          yearTo: 2016,
          bodyType: null,
        },
        {
          id: 'nexia-3',
          makeId: 'chevrolet',
          name: 'Nexia 3',
          yearFrom: 2016,
          yearTo: 2022,
          bodyType: null,
        },
      ],
    });
    const result = await service.run({
      trigger: VehicleImageCatalogDiscoveryTrigger.SCHEDULED,
    });
    expect(result.reviewRequired).toBe(3);
    expect(images.planFor).not.toHaveBeenCalled();
    expect(
      prisma.vehicleImageCatalogDiscovery.upsert.mock.calls.filter(
        ([input]: any[]) =>
          input.create.reason === 'generation_year_ranges_overlap',
      ),
    ).toHaveLength(3);
  });

  it('returns explicit operator actions with durable review records', async () => {
    const { service, prisma } = setup();
    prisma.vehicleImageCatalogDiscovery.findMany
      .mockResolvedValueOnce([
        {
          sourceKey: 'known:missing:model',
          reason: 'model_year_range_missing',
        },
        {
          sourceKey: 'known:overlap:generation',
          reason: 'generation_year_ranges_overlap',
        },
      ])
      .mockResolvedValueOnce([]);
    const status = await service.status();
    expect(status.reviewRequired).toEqual([
      {
        sourceKey: 'known:missing:model',
        reason: 'model_year_range_missing',
        requiredAction: 'supply_sourced_production_years',
      },
      {
        sourceKey: 'known:overlap:generation',
        reason: 'generation_year_ranges_overlap',
        requiredAction: 'review_generation_selection',
      },
    ]);
  });

  it('records a per-identity failure and recovers on the next scan', async () => {
    const { service, images, prisma } = setup();
    images.stage
      .mockRejectedValueOnce(
        Object.assign(new Error('temporary'), { code: 'P1001' }),
      )
      .mockResolvedValueOnce({ outboxId: 'already-scheduled' })
      .mockResolvedValueOnce({ outboxId: 'recovered' })
      .mockResolvedValueOnce({ outboxId: null });
    const failed = await service.run({
      trigger: VehicleImageCatalogDiscoveryTrigger.ADMIN,
    });
    const recovered = await service.run({
      trigger: VehicleImageCatalogDiscoveryTrigger.SCHEDULED,
    });
    expect(failed.failed).toBe(1);
    expect(failed.scheduled).toBe(1);
    expect(recovered.scheduled).toBe(1);
    expect(recovered.existing).toBe(1);
    expect(prisma.vehicleImageCatalogDiscovery.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: VehicleImageCatalogDiscoveryStatus.FAILED,
          lastError: 'P1001',
        }),
      }),
    );
  });
});
