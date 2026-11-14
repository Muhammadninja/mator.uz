import { BadRequestException, NotFoundException } from '@nestjs/common';
import { VehiclesService } from './vehicles.service';
import { VehicleImagesService } from '../vehicle-images/vehicle-images.service';

const N150 = {
  id: 'nexia-2',
  makeId: 'chevrolet',
  name: 'Nexia 2',
  bodyType: null,
  yearFrom: 2008,
  yearTo: 2016,
};
const R3 = {
  ...N150,
  id: 'nexia-3',
  name: 'Nexia 3',
  yearFrom: 2016,
  yearTo: 2022,
};
const NEXIA = {
  id: 'nexia',
  makeId: 'chevrolet',
  name: 'Nexia',
  bodyType: null,
  yearFrom: null,
  yearTo: null,
  variants: [N150, R3],
};
const TRIM = { id: 'nexia-3-ls', modelId: 'nexia', name: 'LS', sortOrder: 13 };

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'veh_1',
    userId: 'usr_1',
    isPrimary: true,
    nickname: null,
    makeId: 'chevrolet',
    modelId: 'nexia',
    year: 2016,
    trimId: null,
    variantModelId: null,
    engineId: null,
    transmission: null,
    drivetrain: null,
    colorHex: null,
    vin: null,
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
    make: { id: 'chevrolet', name: 'Chevrolet', logoUrl: null },
    model: NEXIA,
    trim: null,
    engine: null,
    model3dAsset: null,
    imageIdentity: null,
    ...over,
  };
}

function setup(stored = row()) {
  const prisma: any = {
    vehicleModelRef: { findUnique: jest.fn().mockResolvedValue(NEXIA) },
    vehicleTrim: { findUnique: jest.fn().mockResolvedValue(TRIM) },
    vehicleEngine: { findUnique: jest.fn() },
    vehicle3dAsset: { findFirst: jest.fn().mockResolvedValue(null) },
    vehicle: {
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn(async ({ data }: any) => row(data)),
      update: jest.fn(async ({ data }: any) => ({ ...stored, ...data })),
      findUnique: jest.fn().mockResolvedValue(stored),
      findMany: jest.fn().mockResolvedValue([stored]),
    },
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  const images = {
    prepare: jest.fn(async (input: any) =>
      input.review
        ? { kind: 'review', reason: input.review }
        : { kind: 'request', model: input.model.id },
    ),
    // Same data shape as VehicleImagesService.stage: every snapshot column, explicit nulls.
    stage: jest.fn(async (_tx: any, _id: string, plan: any) =>
      plan.kind === 'review'
        ? {
            data: {
              imageIdentityKey: null,
              imageReviewReason: plan.reason,
              identityModelId: null,
              identityGenerationId: null,
              identityFaceliftId: null,
              identityMarket: null,
            },
            outboxId: null,
          }
        : {
            data: {
              imageIdentityKey: 'k'.repeat(64),
              imageReviewReason: null,
              identityModelId: plan.model,
              identityGenerationId: plan.model,
              identityFaceliftId: null,
              identityMarket: 'UZ',
            },
            outboxId: 'vio_1',
          },
    ),
    kick: jest.fn(),
    refresh: jest.fn(),
  } as Record<string, any>;
  // The real generation step (VehicleImagesService.planFor) over the mocked
  // `prepare`, so these tests still see which catalog row is pictured.
  images.planFor = VehicleImagesService.prototype.planFor.bind(images);
  const svc = new VehiclesService(
    prisma,
    { emitGarageEvent: jest.fn() } as any,
    { emit: jest.fn() } as any,
    images as any,
  );
  return { svc, prisma, images };
}

const create = (year: number, extra: Record<string, unknown> = {}) =>
  ({ make_id: 'chevrolet', model_id: 'nexia', year, ...extra }) as any;

describe('Garage create: generic-model generation', () => {
  it('pictures a year-resolved Nexia as its generation row; the vehicle stays `nexia`', async () => {
    const { svc, prisma, images } = setup();
    const res: any = await svc.create('usr_1', create(2018));
    expect(images.prepare).toHaveBeenCalledWith({
      year: 2018,
      model: R3,
      trim: null,
    });
    const data = prisma.vehicle.create.mock.calls[0][0].data;
    expect(data.modelId).toBe('nexia');
    expect(data.variantModelId).toBeUndefined();
    expect(res.model).toEqual({ id: 'nexia', name: 'Nexia' });
    expect(res.generation).toEqual({
      status: 'resolved',
      source: 'year',
      model: { id: 'nexia-3', name: 'Nexia 3' },
      options: [],
    });
  });

  it('an overlap year asks the pipeline nothing and offers the choice', async () => {
    const { svc, prisma, images } = setup();
    const res: any = await svc.create('usr_1', create(2016));
    expect(images.prepare).toHaveBeenCalledWith({
      year: 2016,
      model: null,
      trim: null,
      review: 'generation_unresolved',
    });
    expect(prisma.vehicle.create.mock.calls[0][0].data.imageReviewReason).toBe(
      'generation_unresolved',
    );
    expect(images.kick).toHaveBeenCalledWith(null);
    expect(res.generation.status).toBe('choice_required');
    expect(res.generation.options.map((o: any) => o.id)).toEqual([
      'nexia-2',
      'nexia-3',
    ]);
  });

  it('does not treat an undecoded VIN or a conflicting VIN year as generation evidence', async () => {
    const { svc, prisma, images } = setup();
    const res: any = await svc.create(
      'usr_1',
      create(2016, { vin: 'XWBTF69V9HA000000' }),
    );
    expect(res.generation.status).toBe('choice_required');
    expect(prisma.vehicle.create.mock.calls[0][0].data).toMatchObject({
      modelId: 'nexia',
      year: 2016,
      vin: 'XWBTF69V9HA000000',
    });
    expect(images.prepare).toHaveBeenCalledWith({
      year: 2016,
      model: null,
      trim: null,
      review: 'generation_unresolved',
    });
  });

  it('a year no verified generation covers is not a car that was built: refused, nothing saved', async () => {
    for (const year of [2007, 2023, 2024]) {
      const { svc, prisma, images } = setup();
      const err: unknown = await svc
        .create('usr_1', create(year))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toEqual({
        code: 'VEHICLE_YEAR_UNSUPPORTED',
        message: `Nexia is not available for ${year}.`,
        details: { year, year_from: 2008, year_to: 2022 },
      });
      expect(images.prepare).not.toHaveBeenCalled();
      expect(prisma.vehicle.create).not.toHaveBeenCalled();
    }
  });

  it('a generation whose range is not verified (open) never rejects a year', async () => {
    const { svc, prisma, images } = setup();
    prisma.vehicleModelRef.findUnique.mockResolvedValue({
      ...NEXIA,
      variants: [N150, { ...R3, yearTo: null }],
    });
    const res: any = await svc.create('usr_1', create(2024));
    expect(images.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ review: 'generation_unresolved' }),
    );
    expect(res.generation.status).toBe('unresolved');
    expect(res.identity).toMatchObject({
      status: 'needs_review',
      reason: 'generation_unresolved',
      model_id: null,
    });
  });

  it('a picked trim keeps the existing identity (model + trim) and no generation', async () => {
    const { svc, images } = setup();
    const res: any = await svc.create(
      'usr_1',
      create(2016, { trim_id: 'nexia-3-ls' }),
    );
    expect(images.prepare).toHaveBeenCalledWith({
      year: 2016,
      model: NEXIA,
      trim: TRIM,
    });
    expect(res.generation).toBeNull();
  });
});

describe('Garage PATCH variant_model_id', () => {
  it("stores the owner's pick, re-plans the picture, and never touches fitment fields", async () => {
    const { svc, prisma, images } = setup();
    const res: any = await svc.update('usr_1', 'veh_1', {
      variant_model_id: 'nexia-3',
    });
    expect(images.prepare).toHaveBeenCalledWith({
      year: 2016,
      model: R3,
      trim: null,
    });
    const { data } = prisma.vehicle.update.mock.calls[0][0];
    expect(data).toMatchObject({
      variantModelId: 'nexia-3',
      imageIdentityKey: 'k'.repeat(64),
      imageReviewReason: null,
      identityModelId: 'nexia-3',
      identityMarket: 'UZ',
    });
    for (const fitment of ['modelId', 'makeId', 'trimId', 'year', 'engineId']) {
      expect(data).not.toHaveProperty(fitment);
    }
    expect(images.kick).toHaveBeenCalledWith('vio_1');
    expect(res.generation).toMatchObject({
      status: 'resolved',
      source: 'owner',
      model: { id: 'nexia-3' },
    });
  });

  it('null clears the pick back to the choice', async () => {
    const { svc, prisma } = setup(row({ variantModelId: 'nexia-3' }));
    const res: any = await svc.update('usr_1', 'veh_1', {
      variant_model_id: null,
    });
    expect(prisma.vehicle.update.mock.calls[0][0].data).toMatchObject({
      variantModelId: null,
      imageIdentityKey: null,
      imageReviewReason: 'generation_unresolved',
      identityModelId: null,
      identityMarket: null,
    });
    expect(res.generation.status).toBe('choice_required');
  });

  it.each([
    ['a generation the year does not allow', row(), 'nexia-1'],
    ['an unrelated model', row(), 'cobalt'],
    ['a year that already decides', row({ year: 2018 }), 'nexia-2'],
    [
      'a vehicle with a trim (more precise; it wins)',
      row({ trimId: 'nexia-3-ls' }),
      'nexia-3',
    ],
  ])('refuses %s, writing nothing', async (_label, stored, pick) => {
    const { svc, prisma, images } = setup(stored);
    await expect(
      svc.update('usr_1', 'veh_1', { variant_model_id: pick }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.vehicle.update).not.toHaveBeenCalled();
    expect(images.stage).not.toHaveBeenCalled();
  });

  it('refuses a model without generation rows', async () => {
    const { svc, prisma } = setup(row({ modelId: 'cobalt' }));
    prisma.vehicleModelRef.findUnique.mockResolvedValue({
      ...NEXIA,
      id: 'cobalt',
      variants: [],
    });
    await expect(
      svc.update('usr_1', 'veh_1', { variant_model_id: 'nexia-3' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("hides another user's vehicle", async () => {
    const { svc, prisma } = setup(row({ userId: 'other' }));
    await expect(
      svc.update('usr_1', 'veh_1', { variant_model_id: 'nexia-3' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.vehicle.update).not.toHaveBeenCalled();
  });

  it('when the catalog cannot be read, stores the pick and leaves the identity and image state alone', async () => {
    const { svc, prisma, images } = setup();
    images.prepare.mockResolvedValue(null as any);
    await svc.update('usr_1', 'veh_1', { variant_model_id: 'nexia-2' });
    const { data } = prisma.vehicle.update.mock.calls[0][0];
    expect(data.variantModelId).toBe('nexia-2');
    expect(data).not.toHaveProperty('imageIdentityKey');
    expect(data).not.toHaveProperty('imageReviewReason');
    expect(data).not.toHaveProperty('identityModelId');
    expect(images.stage).not.toHaveBeenCalled();
  });

  it('an update without variant_model_id changes nothing about the generation', async () => {
    const { svc, prisma, images } = setup(row({ variantModelId: 'nexia-3' }));
    await svc.update('usr_1', 'veh_1', { nickname: 'Daily' });
    expect(prisma.vehicle.update.mock.calls[0][0].data).not.toHaveProperty(
      'variantModelId',
    );
    expect(images.prepare).not.toHaveBeenCalled();
  });
});

describe('Garage list: the pick survives a fresh read (another device, reinstall)', () => {
  it('reads the stored pick back from the vehicle row', async () => {
    const { svc } = setup(row({ variantModelId: 'nexia-2' }));
    const res: any = await svc.list('usr_1', {
      includeDeleted: false,
      include3d: true,
    });
    expect(res.vehicles[0].generation).toMatchObject({
      status: 'resolved',
      source: 'owner',
      model: { id: 'nexia-2', name: 'Nexia 2' },
    });
  });
});
