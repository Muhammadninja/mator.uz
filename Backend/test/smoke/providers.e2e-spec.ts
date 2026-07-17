import { BadRequestException } from '@nestjs/common';
import { ProvidersService } from '../../src/providers/providers.service';
import { BookingsService } from '../../src/providers/bookings.service';
import { ProviderType } from '@prisma/client';
import { createPrismaMock, PrismaMock } from '../utils/harness';

const newBookings = (prisma: PrismaMock, notifications = { emit: jest.fn().mockResolvedValue(undefined) }) => ({
  svc: new BookingsService(prisma, notifications as any),
  notifications,
});

function buildProvider(over: Partial<any> = {}): any {
  return {
    id: 'master_1',
    providerType: 'MASTER',
    displayName: 'Bobur',
    shopName: 'Bobur Auto',
    avatarUrl: null,
    bio: null,
    ratingAvg: 4.8,
    ratingCount: 120,
    geoLat: 41.311,
    geoLng: 69.279,
    geohash: 'tzz',
    addressText: 'Tashkent',
    priceFloorUzs: 50000,
    priceCeilingUzs: 500000,
    badge: null,
    contactPhoneE164: '+998901234567',
    contactTelegram: null,
    contactWebsite: null,
    specializations: [],
    supportedMakes: [],
    workingHours: [],
    ...over,
  };
}

describe('Masters/Bookings smoke', () => {
  let prisma: PrismaMock;
  beforeEach(() => (prisma = createPrismaMock()));

  it('nearby ranks providers by distance from the search center', async () => {
    const svc = new ProvidersService(prisma);
    const near = buildProvider({ id: 'near', geoLat: 41.3115, geoLng: 69.2795 });
    const far = buildProvider({ id: 'far', geoLat: 41.36, geoLng: 69.33 });
    prisma.serviceProvider.findMany.mockResolvedValue([far, near]); // unsorted

    const res = await svc.nearby(ProviderType.MASTER, {
      center_lat: 41.311,
      center_lng: 69.279,
      radius_m: 10000,
    } as any);

    expect(res.results.map((r) => r.id)).toEqual(['near', 'far']);
    expect(res.results[0].distance_m).toBeLessThan(res.results[1].distance_m);
    expect(res.results[0].type).toBe('master');
  });

  it('nearby excludes providers outside the radius', async () => {
    const svc = new ProvidersService(prisma);
    prisma.serviceProvider.findMany.mockResolvedValue([buildProvider({ id: 'far', geoLat: 42.0, geoLng: 70.0 })]);
    const res = await svc.nearby(ProviderType.MASTER, { center_lat: 41.311, center_lng: 69.279, radius_m: 3000 } as any);
    expect(res.results).toHaveLength(0);
  });

  it('creates a 5-minute HOLD booking with the summed price', async () => {
    const { svc } = newBookings(prisma);
    prisma.serviceProvider.findUnique.mockResolvedValue({ id: 'master_1' });
    // The referenced vehicle must belong to the caller (ownership check).
    prisma.vehicle.findUnique.mockResolvedValue({ id: 'veh_1', userId: 'usr_1', deletedAt: null });
    prisma.providerServiceOffering.findMany.mockResolvedValue([
      { id: 'svc_oil', name: 'Oil change', priceUzs: 120000 },
    ]);
    prisma.booking.create.mockResolvedValue({ id: 'bk_1' });

    const res = await svc.create('usr_1', 'master_1', {
      service_ids: ['svc_oil'],
      scheduled_at: '2026-07-01T10:00:00.000Z',
      vehicle_id: 'veh_1',
    } as any);

    expect(res.status).toBe('hold');
    expect(res.total_uzs).toBe(120000);
    expect(res.hold_expires_at).toBeTruthy();
    expect(prisma.booking.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'HOLD' }) }),
    );
  });

  it("rejects a booking referencing another user's vehicle (ownership)", async () => {
    const { svc } = newBookings(prisma);
    prisma.serviceProvider.findUnique.mockResolvedValue({ id: 'master_1' });
    // Vehicle exists but belongs to a different user.
    prisma.vehicle.findUnique.mockResolvedValue({ id: 'veh_other', userId: 'usr_2', deletedAt: null });
    await expect(
      svc.create('usr_1', 'master_1', {
        service_ids: ['svc_oil'],
        scheduled_at: '2026-07-01T10:00:00Z',
        vehicle_id: 'veh_other',
      } as any),
    ).rejects.toThrow(/Vehicle not found/);
  });

  it('rejects a booking whose service_ids do not belong to the provider', async () => {
    const { svc } = newBookings(prisma);
    prisma.serviceProvider.findUnique.mockResolvedValue({ id: 'master_1' });
    prisma.providerServiceOffering.findMany.mockResolvedValue([]); // none matched
    await expect(
      svc.create('usr_1', 'master_1', { service_ids: ['svc_x'], scheduled_at: '2026-07-01T10:00:00Z' } as any),
    ).rejects.toThrow(/invalid for this provider/);
  });

  it('confirm transitions HOLD → CONFIRMED and notifies (booking_confirmed)', async () => {
    const { svc, notifications } = newBookings(prisma);
    prisma.booking.findUnique.mockResolvedValue({ id: 'bk_1', userId: 'usr_1', status: 'HOLD' });
    prisma.booking.update.mockResolvedValue({});

    const res = await svc.confirm('usr_1', 'bk_1');
    expect(res).toEqual({ booking_id: 'bk_1', status: 'confirmed' });
    expect(prisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CONFIRMED' }) }),
    );
    expect(notifications.emit).toHaveBeenCalledWith('usr_1', expect.objectContaining({ type: 'BOOKING_CONFIRMED' }));
  });

  it('cancel transitions to CANCELLED and notifies (booking_cancelled)', async () => {
    const { svc, notifications } = newBookings(prisma);
    prisma.booking.findUnique.mockResolvedValue({ id: 'bk_1', userId: 'usr_1', status: 'CONFIRMED' });
    prisma.booking.update.mockResolvedValue({});

    const res = await svc.cancel('usr_1', 'bk_1');
    expect(res).toEqual({ booking_id: 'bk_1', status: 'cancelled' });
    expect(notifications.emit).toHaveBeenCalledWith('usr_1', expect.objectContaining({ type: 'BOOKING_CANCELLED' }));
  });

  it('cannot confirm a completed booking', async () => {
    const { svc } = newBookings(prisma);
    prisma.booking.findUnique.mockResolvedValue({ id: 'bk_1', userId: 'usr_1', status: 'COMPLETED' });
    await expect(svc.confirm('usr_1', 'bk_1')).rejects.toBeInstanceOf(BadRequestException);
  });
});
