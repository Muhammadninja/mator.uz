import { NotFoundException } from '@nestjs/common';
import { VehiclesService } from '../../src/garage/vehicles/vehicles.service';
import { createPrismaMock, buildVehicle, PrismaMock } from '../utils/harness';

describe('Garage set-primary smoke', () => {
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

  it('get returns an owned vehicle', async () => {
    prisma.vehicle.findUnique.mockResolvedValue(buildVehicle({ id: 'veh_1', userId: 'usr_1', deletedAt: null }));
    const res: any = await svc.get('usr_1', 'veh_1');
    expect(res.id).toBe('veh_1');
  });

  it("get blocks another user's vehicle", async () => {
    prisma.vehicle.findUnique.mockResolvedValue(buildVehicle({ id: 'veh_1', userId: 'other' }));
    await expect(svc.get('usr_1', 'veh_1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('setPrimary demotes others, promotes the target, and emits both events', async () => {
    prisma.vehicle.findUnique.mockResolvedValue(buildVehicle({ id: 'veh_2', userId: 'usr_1', deletedAt: null }));
    prisma.vehicle.updateMany.mockResolvedValue({ count: 1 });
    prisma.vehicle.update.mockResolvedValue(buildVehicle({ id: 'veh_2', userId: 'usr_1', isPrimary: true }));

    const res: any = await svc.setPrimary('usr_1', 'veh_2');

    expect(res.id).toBe('veh_2');
    expect(res.is_primary).toBe(true);
    // demote sibling primaries
    expect(prisma.vehicle.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'usr_1', id: { not: 'veh_2' } }) }),
    );
    expect(realtime.emitGarageEvent).toHaveBeenCalledWith('usr_1', 'vehicle.updated', expect.objectContaining({ id: 'veh_2' }));
    expect(realtime.emitGarageEvent).toHaveBeenCalledWith('usr_1', 'primary_vehicle_changed', expect.objectContaining({ id: 'veh_2' }));
  });

  it("setPrimary blocks another user's vehicle", async () => {
    prisma.vehicle.findUnique.mockResolvedValue(buildVehicle({ id: 'veh_1', userId: 'other' }));
    await expect(svc.setPrimary('usr_1', 'veh_1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
