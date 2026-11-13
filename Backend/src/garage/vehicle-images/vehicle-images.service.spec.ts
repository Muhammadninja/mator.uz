import { VehicleImageOutboxStatus, VehicleImageStatus } from '@prisma/client';
import { VehicleImagesService } from './vehicle-images.service';
import type { IdentityPlan } from './vehicle-image.identity';

const KEY = 'a'.repeat(64);
const PLAN: IdentityPlan = {
  kind: 'request',
  identity: {
    makeId: 'byd',
    modelId: 'byd-han',
    modelYear: 2024,
    generationId: null,
    faceliftId: null,
    bodyType: null,
    trimId: null,
  },
  display: { manufacturer: 'BYD', model: 'Han' },
  identityKey: KEY,
};
/** What a request plan saves on the vehicle (no resolved snapshot on PLAN). */
const LINKED = {
  imageIdentityKey: KEY,
  imageReviewReason: null,
  identityModelId: null,
  identityGenerationId: null,
  identityFaceliftId: null,
  identityMarket: null,
};
const RESOLVED = {
  modelId: 'cobalt',
  generationId: 'cobalt-gen2',
  faceliftId: null,
  marketRegion: 'UZ',
};
const CATALOG_PLAN: IdentityPlan = {
  ...PLAN,
  resolved: RESOLVED,
  catalogAsset: { assetKey: 'cobalt-gen2', match: 'exact' },
};

function setup(
  state: {
    status: VehicleImageStatus;
    reason?: string | null;
    lastSyncedAt?: Date | null;
    catalogAssetKey?: string | null;
  },
  openOutbox = false,
) {
  const tx = {
    vehicleImageIdentity: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        reason: null,
        lastSyncedAt: null,
        catalogAssetKey: null,
        ...state,
      }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    vehicleImageOutbox: {
      findFirst: jest
        .fn()
        .mockResolvedValue(openOutbox ? { id: 'vio_open' } : null),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const delivery = { enabled: true, refresh: jest.fn() };
  const queue = { add: jest.fn().mockResolvedValue({}) };
  const prisma = {
    vehicleMake: {
      findUnique: jest.fn().mockResolvedValue({ id: 'byd', name: 'BYD' }),
    },
    vehicleModelRef: {
      findMany: jest.fn().mockResolvedValue([{ name: 'Song Plus' }]),
    },
  };
  const svc = new VehicleImagesService(
    prisma as any,
    delivery as any,
    queue as any,
  );
  return { svc, tx, delivery, queue, prisma };
}

describe('VehicleImagesService.stage (transactional outbox)', () => {
  it('a new identity gets exactly one outbox row in the same transaction', async () => {
    const { svc, tx } = setup({ status: VehicleImageStatus.PENDING });
    const staged = await svc.stage(tx as any, 'veh_1', PLAN);
    expect(staged.data).toEqual(LINKED);
    expect(staged.outboxId).toMatch(/^vio_/);
    expect(tx.vehicleImageIdentity.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(tx.vehicleImageOutbox.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ id: staged.outboxId, identityKey: KEY }),
      ],
      skipDuplicates: true,
    });
  });

  it('a concurrent duplicate loses on the partial unique index and queues nothing', async () => {
    const { svc, tx } = setup({ status: VehicleImageStatus.PENDING });
    tx.vehicleImageOutbox.createMany.mockResolvedValue({ count: 0 });
    expect((await svc.stage(tx as any, 'veh_1', PLAN)).outboxId).toBeNull();
  });

  it('a request already queued or acknowledged is not sent again', async () => {
    const queued = setup({ status: VehicleImageStatus.PENDING }, true);
    expect(
      (await queued.svc.stage(queued.tx as any, 'veh_1', PLAN)).outboxId,
    ).toBeNull();
    const acked = setup({
      status: VehicleImageStatus.PENDING,
      lastSyncedAt: new Date(),
    });
    expect(
      (await acked.svc.stage(acked.tx as any, 'veh_1', PLAN)).outboxId,
    ).toBeNull();
    expect(acked.tx.vehicleImageOutbox.createMany).not.toHaveBeenCalled();
  });

  it('an approved identity is reused immediately, with no request', async () => {
    const { svc, tx } = setup({ status: VehicleImageStatus.APPROVED });
    const staged = await svc.stage(tx as any, 'veh_1', PLAN);
    expect(staged).toEqual({ data: LINKED, outboxId: null });
  });

  it.each(['generation_failed', 'rejected'])(
    'a %s identity is never re-requested (no automatic regeneration)',
    async (reason) => {
      const { svc, tx } = setup({
        status: VehicleImageStatus.UNAVAILABLE,
        reason,
      });
      expect((await svc.stage(tx as any, 'veh_1', PLAN)).outboxId).toBeNull();
      expect(tx.vehicleImageIdentity.updateMany).not.toHaveBeenCalled();
      expect(tx.vehicleImageOutbox.createMany).not.toHaveBeenCalled();
    },
  );

  const RESET = {
    status: VehicleImageStatus.PENDING,
    reason: null,
    imageUrl: null,
    imageVersion: null,
    catalogAssetKey: null,
    lastSyncedAt: null,
    nextSyncAt: null,
  };

  it.each(['dispatch_failed', 'request_missing', 'not_requested'])(
    'a %s identity (no AI job failed) is requested again',
    async (reason) => {
      const { svc, tx } = setup({
        status: VehicleImageStatus.UNAVAILABLE,
        reason,
      });
      const staged = await svc.stage(tx as any, 'veh_1', PLAN);
      expect(tx.vehicleImageIdentity.updateMany).toHaveBeenCalledWith({
        where: {
          identityKey: KEY,
          status: VehicleImageStatus.UNAVAILABLE,
          reason,
          catalogAssetKey: null,
        },
        data: RESET,
      });
      expect(staged.outboxId).toMatch(/^vio_/);
    },
  );

  it('a registry image whose approval was withdrawn is asked of the pipeline once', async () => {
    const { svc, tx } = setup({
      status: VehicleImageStatus.APPROVED,
      catalogAssetKey: 'spark-m300',
    });
    const staged = await svc.stage(tx as any, 'veh_1', PLAN);
    expect(tx.vehicleImageIdentity.updateMany).toHaveBeenCalledWith({
      where: {
        identityKey: KEY,
        status: VehicleImageStatus.APPROVED,
        reason: null,
        catalogAssetKey: 'spark-m300',
      },
      data: RESET,
    });
    expect(staged.outboxId).toMatch(/^vio_/);
  });

  it('an approved registry image wins: saved as approved, no pipeline, no outbox, never synced', async () => {
    for (const enabled of [true, false]) {
      const { svc, tx, delivery } = setup({
        status: VehicleImageStatus.UNAVAILABLE,
        reason: 'request_missing',
      });
      delivery.enabled = enabled;
      const staged = await svc.stage(tx as any, 'veh_1', CATALOG_PLAN);
      const catalog = {
        status: VehicleImageStatus.APPROVED,
        reason: null,
        imageUrl: null,
        imageVersion: 1,
        catalogAssetKey: 'cobalt-gen2',
        lastSyncedAt: null,
        nextSyncAt: null,
      };
      const [[created]] = tx.vehicleImageIdentity.createMany.mock.calls as [
        [{ data: unknown[] }],
      ];
      expect(created.data[0]).toMatchObject(catalog);
      expect(tx.vehicleImageIdentity.update).toHaveBeenCalledWith({
        where: { identityKey: KEY },
        data: catalog,
      });
      expect(staged).toEqual({
        data: {
          imageIdentityKey: KEY,
          imageReviewReason: null,
          identityModelId: 'cobalt',
          identityGenerationId: 'cobalt-gen2',
          identityFaceliftId: null,
          identityMarket: 'UZ',
        },
        outboxId: null,
      });
      expect(tx.vehicleImageOutbox.createMany).not.toHaveBeenCalled();
    }
  });

  it('integration off: a verified identity is saved as not requested, nothing is queued', async () => {
    const { svc, tx, delivery } = setup({ status: VehicleImageStatus.PENDING });
    delivery.enabled = false;
    const staged = await svc.stage(tx as any, 'veh_1', {
      ...PLAN,
      resolved: RESOLVED,
      catalogAsset: null,
    });
    const [[created]] = tx.vehicleImageIdentity.createMany.mock.calls as [
      [{ data: unknown[] }],
    ];
    expect(created.data[0]).toMatchObject({
      identityKey: KEY,
      status: VehicleImageStatus.UNAVAILABLE,
      reason: 'not_requested',
    });
    expect(staged.data).toMatchObject({
      imageIdentityKey: KEY,
      identityMarket: 'UZ',
    });
    expect(staged.outboxId).toBeNull();
    expect(tx.vehicleImageIdentity.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(tx.vehicleImageOutbox.createMany).not.toHaveBeenCalled();
  });

  it('an ambiguous identity is flagged on the vehicle and touches nothing else', async () => {
    const { svc, tx } = setup({ status: VehicleImageStatus.PENDING });
    const staged = await svc.stage(tx as any, 'veh_1', {
      kind: 'review',
      reason: 'duplicate_model_name',
    });
    expect(staged).toEqual({
      data: {
        imageIdentityKey: null,
        imageReviewReason: 'duplicate_model_name',
        identityModelId: null,
        identityGenerationId: null,
        identityFaceliftId: null,
        identityMarket: null,
      },
      outboxId: null,
    });
    expect(tx.vehicleImageIdentity.createMany).not.toHaveBeenCalled();
  });

  it('no plan (catalog unreadable) writes nothing', async () => {
    const { svc, tx } = setup({ status: VehicleImageStatus.PENDING });
    expect(await svc.stage(tx as any, 'veh_1', null)).toEqual({
      data: {},
      outboxId: null,
    });
    expect(tx.vehicleImageIdentity.createMany).not.toHaveBeenCalled();
  });

  it('only looks for open outbox rows in PENDING', async () => {
    const { svc, tx } = setup({ status: VehicleImageStatus.PENDING });
    await svc.stage(tx as any, 'veh_1', PLAN);
    expect(tx.vehicleImageOutbox.findFirst).toHaveBeenCalledWith({
      where: { identityKey: KEY, status: VehicleImageOutboxStatus.PENDING },
      select: { id: true },
    });
  });
});

describe('VehicleImagesService.prepare / kick', () => {
  const model = {
    id: 'byd-han',
    makeId: 'byd',
    name: 'Han',
    bodyType: null,
    yearFrom: null,
    yearTo: null,
  };

  const cobalt = {
    id: 'cobalt',
    makeId: 'chevrolet',
    name: 'Cobalt',
    bodyType: 'Sedan',
    yearFrom: null,
    yearTo: null,
  };

  it('builds the plan from catalog tables and the registry, enabled or not', async () => {
    for (const enabled of [true, false]) {
      const { svc, prisma, delivery } = setup({
        status: VehicleImageStatus.PENDING,
      });
      delivery.enabled = enabled;
      prisma.vehicleMake.findUnique.mockResolvedValue({
        id: 'chevrolet',
        name: 'Chevrolet',
      });
      prisma.vehicleModelRef.findMany.mockResolvedValue([{ name: 'Gentra' }]);
      const plan = await svc.prepare({ year: 2020, model: cobalt, trim: null });
      expect(plan).toMatchObject({
        kind: 'request',
        identity: {
          makeId: 'chevrolet',
          modelId: 'cobalt',
          marketRegion: 'UZ',
        },
        resolved: {
          modelId: 'cobalt',
          generationId: 'cobalt-gen2',
          marketRegion: 'UZ',
        },
        catalogAsset: { assetKey: 'cobalt-gen2', match: 'exact' },
      });
      expect(prisma.vehicleModelRef.findMany).toHaveBeenCalledWith({
        where: { makeId: 'chevrolet', id: { not: 'cobalt' } },
        select: { name: true },
      });
    }
  });

  it('a model no verified registry entry covers is kept for review, never requested', async () => {
    const { svc } = setup({ status: VehicleImageStatus.PENDING });
    expect(await svc.prepare({ year: 2024, model, trim: null })).toEqual({
      kind: 'review',
      reason: 'market_unverified',
    });
  });

  it('returns null when the catalog read fails (creation goes on)', async () => {
    const broken = setup({ status: VehicleImageStatus.PENDING });
    broken.prisma.vehicleMake.findUnique.mockRejectedValue(
      new Error('db down'),
    );
    expect(
      await broken.svc.prepare({ year: 2024, model, trim: null }),
    ).toBeNull();
  });

  it('an unresolved generation is a review, never a request, enabled or not', async () => {
    for (const enabled of [true, false]) {
      const { svc, prisma, delivery } = setup({
        status: VehicleImageStatus.PENDING,
      });
      delivery.enabled = enabled;
      expect(
        await svc.prepare({
          year: 2016,
          model: null,
          trim: null,
          review: 'generation_unresolved',
        }),
      ).toEqual({ kind: 'review', reason: 'generation_unresolved' });
      expect(prisma.vehicleMake.findUnique).not.toHaveBeenCalled();
    }
  });

  it('kick is fire-and-forget: a Redis failure never reaches the caller', async () => {
    const { svc, queue } = setup({ status: VehicleImageStatus.PENDING });
    queue.add.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(() => svc.kick('vio_1')).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(queue.add).toHaveBeenCalledWith(
      'dispatch',
      { outboxId: 'vio_1', attempt: 0 },
      expect.objectContaining({ jobId: 'vio_1-a0', attempts: 1 }),
    );
    svc.kick(null);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });
});
