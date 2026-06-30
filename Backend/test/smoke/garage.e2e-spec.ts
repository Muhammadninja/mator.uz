import { NotFoundException } from '@nestjs/common';
import { VehiclesService } from '../../src/garage/vehicles/vehicles.service';
import { createPrismaMock, buildVehicle, PrismaMock } from '../utils/harness';

describe('Garage smoke', () => {
  let prisma: PrismaMock;
  let realtime: { emitGarageEvent: jest.Mock };
  let notifications: { emit: jest.Mock };
  let svc: VehiclesService;

  beforeEach(() => {
    prisma = createPrismaMock();
    realtime = { emitGarageEvent: jest.fn() };
    notifications = { emit: jest.fn().mockResolvedValue(undefined) };
    svc = new VehiclesService(prisma, realtime as any, notifications as any);
  });

  const createDto = {
    make_id: 'make_chevrolet',
    model_id: 'model_cobalt',
    year: 2022,
    trim_id: 'trim_lt',
    engine_id: 'engine_b15d2',
    transmission: 'automatic',
    drivetrain: 'fwd',
    fuel_type: 'petrol',
  } as any;

  it('creates the first vehicle as primary and emits vehicle.created', async () => {
    prisma.vehicleModelRef.findUnique.mockResolvedValue({ id: 'model_cobalt', makeId: 'make_chevrolet' });
    prisma.vehicleTrim.findUnique.mockResolvedValue({ id: 'trim_lt', modelId: 'model_cobalt' });
    prisma.vehicleEngine.findUnique.mockResolvedValue({ id: 'engine_b15d2' });
    prisma.vehicle3dAsset.findFirst.mockResolvedValue(null);
    prisma.vehicle.count.mockResolvedValue(0);
    prisma.vehicle.updateMany.mockResolvedValue({ count: 0 });
    prisma.vehicle.create.mockResolvedValue(buildVehicle({ id: 'veh_1', userId: 'usr_1', isPrimary: true }));

    const res = await svc.create('usr_1', createDto);

    expect(res.id).toBe('veh_1');
    expect(res.is_primary).toBe(true);
    expect(res.make).toEqual({ id: 'make_chevrolet', name: 'Chevrolet', logo_url: null });
    expect(prisma.vehicle.create).toHaveBeenCalled();
    expect(realtime.emitGarageEvent).toHaveBeenCalledWith(
      'usr_1',
      'vehicle.created',
      expect.objectContaining({ id: 'veh_1' }),
    );
  });

  it('rejects a mismatched make/model with a 400', async () => {
    prisma.vehicleModelRef.findUnique.mockResolvedValue({ id: 'model_cobalt', makeId: 'make_other' });
    await expect(svc.create('usr_1', createDto)).rejects.toThrow(/make_id\/model_id/);
  });

  it('updates a vehicle, emitting realtime + a vehicle_status_updated notification', async () => {
    prisma.vehicle.findUnique.mockResolvedValue(buildVehicle({ id: 'veh_1', userId: 'usr_1', deletedAt: null }));
    prisma.vehicle.updateMany.mockResolvedValue({ count: 0 });
    prisma.vehicle.update.mockResolvedValue(buildVehicle({ id: 'veh_1', userId: 'usr_1', mileageKm: 50000 }));

    await svc.update('usr_1', 'veh_1', { mileage_km: 50000 } as any);

    expect(realtime.emitGarageEvent).toHaveBeenCalledWith('usr_1', 'vehicle.updated', expect.objectContaining({ id: 'veh_1' }));
    expect(notifications.emit).toHaveBeenCalledWith(
      'usr_1',
      expect.objectContaining({ type: 'VEHICLE_STATUS_UPDATED', data: { vehicle_id: 'veh_1' } }),
    );
  });

  it('soft-deletes a vehicle and emits vehicle.deleted', async () => {
    prisma.vehicle.findUnique.mockResolvedValue(
      buildVehicle({ id: 'veh_1', userId: 'usr_1', isPrimary: false, deletedAt: null }),
    );
    prisma.vehicle.update.mockResolvedValue({});
    prisma.vehicle.findFirst.mockResolvedValue(null);

    const res = await svc.remove('usr_1', 'veh_1');

    expect(res).toEqual({ id: 'veh_1', deleted: true });
    expect(realtime.emitGarageEvent).toHaveBeenCalledWith('usr_1', 'vehicle.deleted', { id: 'veh_1' });
  });

  it("blocks deleting another user's vehicle", async () => {
    prisma.vehicle.findUnique.mockResolvedValue(buildVehicle({ id: 'veh_1', userId: 'someone_else' }));
    await expect(svc.remove('usr_1', 'veh_1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
