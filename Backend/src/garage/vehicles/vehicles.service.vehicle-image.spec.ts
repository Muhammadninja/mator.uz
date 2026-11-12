import { NotFoundException } from '@nestjs/common';
import { VehicleImageStatus } from '@prisma/client';
import { VehiclesService } from './vehicles.service';

const MODEL = {
  id: 'byd-han',
  makeId: 'byd',
  name: 'Han',
  bodyType: null,
  yearFrom: null,
  yearTo: null,
  variants: [],
};

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'veh_1',
    userId: 'usr_1',
    isPrimary: true,
    nickname: null,
    makeId: 'byd',
    modelId: 'byd-han',
    year: 2024,
    trimId: null,
    engineId: null,
    transmission: null,
    drivetrain: null,
    colorHex: null,
    vin: 'XWB0000000000001',
    licensePlate: null,
    registrationRegionCode: null,
    mileageKm: null,
    fuelType: null,
    model3dAssetId: null,
    imageIdentityKey: null,
    imageReviewReason: null,
    deletedAt: null,
    createdAt: new Date('2026-11-12T00:00:00Z'),
    updatedAt: new Date('2026-11-12T00:00:00Z'),
    make: { id: 'byd', name: 'BYD', logoUrl: null },
    model: MODEL,
    trim: null,
    engine: null,
    model3dAsset: null,
    imageIdentity: null,
    ...over,
  };
}

function setup() {
  const prisma: any = {
    vehicleModelRef: { findUnique: jest.fn().mockResolvedValue(MODEL) },
    vehicleTrim: { findUnique: jest.fn() },
    vehicleEngine: { findUnique: jest.fn() },
    vehicle3dAsset: { findFirst: jest.fn() },
    vehicle: {
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn(),
      findUnique: jest.fn(),
    },
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  const images = {
    prepare: jest.fn().mockResolvedValue({ kind: 'request' }),
    stage: jest.fn().mockResolvedValue({
      data: { imageIdentityKey: 'k'.repeat(64) },
      outboxId: 'vio_1',
    }),
    kick: jest.fn(),
    refresh: jest.fn().mockResolvedValue(undefined),
  };
  const realtime = { emitGarageEvent: jest.fn() };
  const svc = new VehiclesService(
    prisma,
    realtime as any,
    { emit: jest.fn() } as any,
    images as any,
  );
  return { svc, prisma, images, realtime };
}

describe('VehiclesService + vehicle images', () => {
  const dto = {
    make_id: 'byd',
    model_id: 'byd-han',
    year: 2024,
    vin: 'XWB0000000000001',
  } as any;

  it('stages the image request inside the create transaction and kicks it after commit', async () => {
    const { svc, prisma, images } = setup();
    const order: string[] = [];
    images.stage.mockImplementation(
      async () => (
        order.push('stage'),
        { data: { imageIdentityKey: 'k'.repeat(64) }, outboxId: 'vio_1' }
      ),
    );
    prisma.vehicle.create.mockImplementation(
      async () => (
        order.push('create'),
        row({
          imageIdentityKey: 'k'.repeat(64),
          imageIdentity: {
            status: VehicleImageStatus.PENDING,
            reason: null,
            imageUrl: null,
            imageVersion: null,
          },
        })
      ),
    );
    images.kick.mockImplementation(() => order.push('kick'));

    const res: any = await svc.create('usr_1', dto);

    expect(order).toEqual(['stage', 'create', 'kick']);
    expect(images.prepare).toHaveBeenCalledWith({
      year: 2024,
      model: MODEL,
      trim: null,
    });
    // Only catalog facts reach the image identity, never the VIN.
    expect(JSON.stringify(images.prepare.mock.calls[0])).not.toContain('XWB');
    const createdId = prisma.vehicle.create.mock.calls[0][0].data.id;
    expect(images.stage).toHaveBeenCalledWith(prisma, createdId, {
      kind: 'request',
    });
    expect(prisma.vehicle.create.mock.calls[0][0].data).toMatchObject({
      imageIdentityKey: 'k'.repeat(64),
      vin: 'XWB0000000000001',
    });
    expect(images.kick).toHaveBeenCalledWith('vio_1');
    expect(res.vehicle_image).toEqual({
      status: 'pending',
      url: null,
      version: null,
      reason: null,
    });
    expect(res.vin).toBe('XWB0000000000001');
  });

  it('a rolled-back create queues nothing', async () => {
    const { svc, prisma, images } = setup();
    prisma.vehicle.create.mockRejectedValue(new Error('constraint'));
    await expect(svc.create('usr_1', dto)).rejects.toThrow('constraint');
    expect(images.kick).not.toHaveBeenCalled();
  });

  it('list exposes vehicle_image on every vehicle, legacy ones included', async () => {
    const { svc, prisma } = setup();
    prisma.vehicle.findMany = jest.fn().mockResolvedValue([
      row(),
      row({
        id: 'veh_2',
        imageIdentity: {
          status: VehicleImageStatus.APPROVED,
          reason: null,
          imageUrl: 'https://cdn.test/h.webp',
          imageVersion: 2,
        },
      }),
    ]);
    const res: any = await svc.list('usr_1', {
      includeDeleted: false,
      include3d: true,
    });
    expect(res.vehicles.map((v: any) => v.vehicle_image)).toEqual([
      {
        status: 'unavailable',
        url: null,
        version: null,
        reason: 'not_requested',
      },
      {
        status: 'approved',
        url: 'https://cdn.test/h.webp',
        version: 2,
        reason: null,
      },
    ]);
  });

  it('GET /:id/image refreshes the owned vehicle and returns its state', async () => {
    const { svc, prisma, images } = setup();
    prisma.vehicle.findUnique
      .mockResolvedValueOnce(row({ imageIdentityKey: 'k'.repeat(64) }))
      .mockResolvedValueOnce({
        imageReviewReason: null,
        imageIdentity: {
          status: VehicleImageStatus.APPROVED,
          reason: null,
          imageUrl: 'https://cdn.test/h.webp',
          imageVersion: 1,
        },
      });
    await expect(svc.getImage('usr_1', 'veh_1')).resolves.toEqual({
      vehicle_id: 'veh_1',
      vehicle_image: {
        status: 'approved',
        url: 'https://cdn.test/h.webp',
        version: 1,
        reason: null,
      },
    });
    expect(images.refresh).toHaveBeenCalledWith('k'.repeat(64));
  });

  it("GET /:id/image hides another user's vehicle", async () => {
    const { svc, prisma, images } = setup();
    prisma.vehicle.findUnique.mockResolvedValue(row({ userId: 'other' }));
    await expect(svc.getImage('usr_1', 'veh_1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(images.refresh).not.toHaveBeenCalled();
  });
});
