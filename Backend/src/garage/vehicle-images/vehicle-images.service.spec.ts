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

function setup(
  state: {
    status: VehicleImageStatus;
    reason?: string | null;
    lastSyncedAt?: Date | null;
  },
  openOutbox = false,
) {
  const tx = {
    vehicleImageIdentity: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ reason: null, lastSyncedAt: null, ...state }),
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
    expect(staged.data).toEqual({ imageIdentityKey: KEY });
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
    expect(staged).toEqual({ data: { imageIdentityKey: KEY }, outboxId: null });
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

  it.each(['dispatch_failed', 'request_missing'])(
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
        },
        data: {
          status: VehicleImageStatus.PENDING,
          reason: null,
          lastSyncedAt: null,
          nextSyncAt: null,
        },
      });
      expect(staged.outboxId).toMatch(/^vio_/);
    },
  );

  it('an ambiguous identity is flagged on the vehicle and touches nothing else', async () => {
    const { svc, tx } = setup({ status: VehicleImageStatus.PENDING });
    const staged = await svc.stage(tx as any, 'veh_1', {
      kind: 'review',
      reason: 'duplicate_model_name',
    });
    expect(staged).toEqual({
      data: { imageReviewReason: 'duplicate_model_name' },
      outboxId: null,
    });
    expect(tx.vehicleImageIdentity.createMany).not.toHaveBeenCalled();
  });

  it('disabled (no plan) writes nothing', async () => {
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

  it('builds the plan from catalog tables', async () => {
    const { svc, prisma } = setup({ status: VehicleImageStatus.PENDING });
    const plan = await svc.prepare({ year: 2024, model, trim: null });
    expect(plan).toMatchObject({
      kind: 'request',
      identity: PLAN.kind === 'request' ? PLAN.identity : null,
    });
    expect(prisma.vehicleModelRef.findMany).toHaveBeenCalledWith({
      where: { makeId: 'byd', id: { not: 'byd-han' } },
      select: { name: true },
    });
  });

  it('returns null when disabled or when the catalog read fails (creation goes on)', async () => {
    const off = setup({ status: VehicleImageStatus.PENDING });
    off.delivery.enabled = false;
    expect(await off.svc.prepare({ year: 2024, model, trim: null })).toBeNull();
    const broken = setup({ status: VehicleImageStatus.PENDING });
    broken.prisma.vehicleMake.findUnique.mockRejectedValue(
      new Error('db down'),
    );
    expect(
      await broken.svc.prepare({ year: 2024, model, trim: null }),
    ).toBeNull();
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
