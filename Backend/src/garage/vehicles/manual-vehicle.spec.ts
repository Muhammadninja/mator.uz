import { BadRequestException } from '@nestjs/common';
import { normalizeVehicleName, parseVehicleSource } from './manual-vehicle';
import { VehiclesService } from './vehicles.service';
import { presentVehicle } from './vehicle.presenter';
import { currentYearInUzbekistan } from './vehicle-year';
import { toVehicleFitContext, vehicleFitWhere } from '../../catalog/compatibility/vehicle-fitment';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return ((e as BadRequestException).getResponse() as { code?: string }).code;
  }
  return null;
};

describe('normalizeVehicleName', () => {
  it('trims, collapses whitespace and keeps Cyrillic or Latin names', () => {
    expect(normalizeVehicleName('  Great   Wall  ', 'f')).toBe('Great Wall');
    expect(normalizeVehicleName('Москвич 3', 'f')).toBe('Москвич 3');
  });

  it('refuses blank, symbol-only, control-character and over-long names', () => {
    for (const bad of ['', '   ', '---', 'Ok\u0000', 'A‮B', 'x'.repeat(61), 42]) {
      expect(code(() => normalizeVehicleName(bad, 'f'))).toBe('VEHICLE_MANUAL_NAME_INVALID');
    }
    expect(normalizeVehicleName('x'.repeat(60), 'f')).toHaveLength(60);
  });
});

describe('parseVehicleSource', () => {
  it('keeps the catalog flow unchanged', () => {
    expect(parseVehicleSource({ make_id: 'chevrolet', model_id: 'cobalt' })).toEqual({
      kind: 'catalog', makeId: 'chevrolet', modelId: 'cobalt',
    });
  });

  it('accepts a listed make with a typed model, or a typed make and model', () => {
    expect(parseVehicleSource({ make_id: 'kia', custom_model_name: ' EV9 ' })).toEqual({
      kind: 'manual', makeId: 'kia', customMakeName: null, customModelName: 'EV9',
    });
    expect(parseVehicleSource({ custom_make_name: 'Zeekr', custom_model_name: '001' })).toEqual({
      kind: 'manual', makeId: null, customMakeName: 'Zeekr', customModelName: '001',
    });
  });

  it('refuses mixed or incomplete requests instead of guessing', () => {
    for (const dto of [
      {},
      { make_id: 'kia' },
      { make_id: 'kia', model_id: 'kia-k5', custom_model_name: 'K5' },
      { make_id: 'kia', custom_make_name: 'Kia', custom_model_name: 'EV9' },
      { custom_make_name: 'Zeekr' },
      { custom_model_name: '001' },
      { make_id: 'kia', custom_model_name: 'EV9', trim_id: 'x' },
    ]) {
      expect(code(() => parseVehicleSource(dto))).toBe('VEHICLE_SOURCE_INVALID');
    }
  });
});

function manualRow(over: Record<string, unknown> = {}) {
  return {
    id: 'veh_m', userId: 'usr_1', isPrimary: true, nickname: null,
    makeId: null, modelId: null, customMakeName: 'Zeekr', customModelName: '001',
    year: 2024, trimId: null, variantModelId: null, engineId: null, transmission: null,
    drivetrain: null, colorHex: null, vin: null, licensePlate: null, registrationRegionCode: null,
    mileageKm: null, fuelType: null, model3dAssetId: null, imageIdentityKey: null,
    imageReviewReason: null, identityModelId: null, identityGenerationId: null,
    identityFaceliftId: null, identityMarket: null, identityResolvedWith: null, deletedAt: null,
    createdAt: new Date('2026-11-17T00:00:00Z'), updatedAt: new Date('2026-11-17T00:00:00Z'),
    make: null, model: null, trim: null, engine: null, model3dAsset: null, imageIdentity: null,
    ...over,
  };
}

function setup(stored: Record<string, unknown> = manualRow()) {
  const prisma: any = {
    vehicleMake: {
      findUnique: jest.fn(async ({ where }: any) =>
        ({ kia: { id: 'kia', name: 'Kia', isActive: true }, lada: { id: 'lada', name: 'Lada', isActive: false } } as any)[where.id] ?? null),
      findMany: jest.fn().mockResolvedValue([{ id: 'kia', name: 'Kia' }, { id: 'chevrolet', name: 'Chevrolet' }]),
    },
    vehicleModelRef: {
      findMany: jest.fn(async ({ where }: any) => (where.makeId === 'kia' ? [{ id: 'kia-k5', name: 'K5' }] : [])),
    },
    vehicle: {
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn(),
      create: jest.fn(async ({ data }: any) => manualRow({
        ...data,
        make: data.makeId === 'kia' ? { id: 'kia', name: 'Kia', logoUrl: null } : null,
      })),
      update: jest.fn(async ({ data }: any) => ({ ...stored, ...data })),
      findUnique: jest.fn().mockResolvedValue(stored),
    },
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  const images: any = {
    planFor: jest.fn(),
    stage: jest.fn(async (_tx: any, _id: string, plan: any) => ({ data: {}, outboxId: plan ? 'x' : null })),
    kick: jest.fn(),
  };
  const service = new VehiclesService(
    prisma,
    { emitGarageEvent: jest.fn() } as any,
    { emit: jest.fn() } as any,
    images,
  );
  return { service, prisma, images };
}

const errorCode = async (p: Promise<unknown>) =>
  p.then(() => null, (e: BadRequestException) => (e.getResponse() as { code?: string }).code ?? (e.getResponse() as any).message);

describe('VehiclesService manual vehicles', () => {
  it('saves a listed make with a typed model: no catalog model id, no picture request', async () => {
    const { service, prisma, images } = setup();
    const v = await service.create('usr_1', { make_id: 'kia', custom_model_name: 'EV9', year: 2024 } as any);
    expect(prisma.vehicle.create.mock.calls[0][0].data).toMatchObject({
      makeId: 'kia', modelId: null, customMakeName: null, customModelName: 'EV9',
    });
    expect(images.planFor).not.toHaveBeenCalled();
    expect(images.stage).toHaveBeenCalledWith(expect.anything(), expect.any(String), null);
    expect(v).toMatchObject({ make: { id: 'kia', name: 'Kia' }, model: { id: null, name: 'EV9' }, is_custom: true });
  });

  it('saves a typed make and model with null catalog ids', async () => {
    const { service, prisma } = setup();
    const v = await service.create('usr_1', { custom_make_name: 'Zeekr', custom_model_name: '001', year: 2024 } as any);
    expect(prisma.vehicle.create.mock.calls[0][0].data).toMatchObject({
      makeId: null, modelId: null, customMakeName: 'Zeekr', customModelName: '001',
    });
    expect(v).toMatchObject({ make: { id: null, name: 'Zeekr', logo_url: null }, model: { id: null, name: '001' } });
  });

  it('refuses a year after this year for a manual vehicle', async () => {
    const { service } = setup();
    expect(await errorCode(service.create('usr_1', {
      custom_make_name: 'Zeekr', custom_model_name: '001', year: currentYearInUzbekistan() + 1,
    } as any))).toBe('VEHICLE_YEAR_IN_FUTURE');
  });

  it('points the owner to the catalog when the typed name is listed', async () => {
    const { service } = setup();
    expect(await errorCode(service.create('usr_1', { make_id: 'kia', custom_model_name: ' k5 ', year: 2022 } as any)))
      .toBe('VEHICLE_IN_CATALOG');
    expect(await errorCode(service.create('usr_1', { custom_make_name: 'KIA', custom_model_name: 'EV9', year: 2022 } as any)))
      .toBe('VEHICLE_IN_CATALOG');
  });

  it('refuses an unknown or hidden catalog make', async () => {
    const { service } = setup();
    expect(await errorCode(service.create('usr_1', { make_id: 'nope', custom_model_name: 'X', year: 2020 } as any)))
      .toBe('Unknown make_id');
    expect(await errorCode(service.create('usr_1', { make_id: 'lada', custom_model_name: 'Iskra', year: 2025 } as any)))
      .toBe('Unknown make_id');
  });

  it('renames a manual vehicle and refuses typed names on a catalog vehicle', async () => {
    const manual = setup();
    await manual.service.update('usr_1', 'veh_m', { custom_model_name: ' 001 FR ' } as any);
    expect(manual.prisma.vehicle.update.mock.calls[0][0].data).toMatchObject({ customModelName: '001 FR' });

    const catalog = setup(manualRow({ makeId: 'kia', modelId: 'kia-k5', customMakeName: null, customModelName: null }));
    expect(await errorCode(catalog.service.update('usr_1', 'veh_m', { custom_model_name: 'K5' } as any)))
      .toBe('VEHICLE_SOURCE_INVALID');
  });
});

describe('manual vehicles in reads and fitment', () => {
  it('a catalog vehicle reads exactly as before, with is_custom false', () => {
    const v = presentVehicle(manualRow({
      makeId: 'kia', modelId: 'kia-k5', customMakeName: null, customModelName: null,
      make: { id: 'kia', name: 'Kia', logoUrl: null }, model: { id: 'kia-k5', name: 'K5', variants: [] },
    }) as any);
    expect(v).toMatchObject({ make: { id: 'kia', name: 'Kia' }, model: { id: 'kia-k5', name: 'K5' }, is_custom: false });
  });

  it('never matches a part on the typed model name: no curated or per-model row, so no exact fit', () => {
    const typedMakeAndModel = toVehicleFitContext(manualRow() as any);
    expect(typedMakeAndModel).toMatchObject({ modelId: null, makeName: null, modelName: null });
    // Only universal parts are listed for a typed make.
    expect(vehicleFitWhere(typedMakeAndModel)).toEqual({ OR: [{ isUniversal: true }] });

    const listedMake = toVehicleFitContext(manualRow({ makeId: 'kia', make: { name: 'Kia' } }) as any);
    expect(listedMake).toMatchObject({ modelId: null, makeName: 'Kia', modelName: null });
    // Universal plus make-wide rows; no per-model legacy row (they need a model name).
    const where = vehicleFitWhere(listedMake) as any;
    expect(JSON.stringify(where)).not.toContain('modelName');
    expect(JSON.stringify(where)).toContain('makeFits');
  });
});
