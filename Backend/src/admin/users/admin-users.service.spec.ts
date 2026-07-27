// Unit tests for the admin users console (GET /v1/admin/users[/:id],
// /:id/addresses, /:id/vehicles). Prisma is mocked — no DB. These guard:
// pagination meta + offset math, the whitelisted sort mapping, the USER-role
// scope, phone-normalized search, the per-page aggregate join (spend/last-order
// without an N+1), the spend-status filter, the row/detail presenter shapes,
// and the resource split — the profile must NOT embed addresses or recent
// orders. A separate block validates the query DTO rejects bad sort input (400).

import { NotFoundException } from '@nestjs/common';
import { Language, MyIdStatus, OrderStatus, Role } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AdminUsersService } from './admin-users.service';
import { ListAdminUsersQueryDto } from './dto/list-admin-users.query.dto';

function makePrismaMock() {
  const appUser = {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    count: jest.fn(),
  };
  const order = {
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
    count: jest.fn().mockResolvedValue(0),
    aggregate: jest.fn().mockResolvedValue({ _sum: { totalUzs: null } }),
    groupBy: jest.fn().mockResolvedValue([]),
  };
  const address = { findMany: jest.fn().mockResolvedValue([]) };
  const vehicle = { findMany: jest.fn().mockResolvedValue([]) };
  const prisma: Record<string, unknown> = { appUser, order, address, vehicle };
  // Array form runs the (already-invoked) query promises; callback form gets the mock.
  prisma.$transaction = (arg: unknown) =>
    Array.isArray(arg)
      ? Promise.all(arg)
      : (arg as (tx: unknown) => unknown)(prisma);
  return prisma as {
    appUser: typeof appUser;
    order: typeof order;
    address: typeof address;
    vehicle: typeof vehicle;
    $transaction: (arg: unknown) => unknown;
  };
}

function listRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'usr_1',
    displayName: 'Ali Valiyev',
    firstName: 'Ali',
    lastName: 'Valiyev',
    phoneE164: '+998903700340',
    email: 'ali@example.com',
    createdAt: new Date('2026-07-01T10:00:00.000Z'),
    _count: { orders: 3 },
    ...over,
  };
}

function detailRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'usr_1',
    displayName: 'Ali Valiyev',
    firstName: 'Ali',
    lastName: 'Valiyev',
    phoneE164: '+998903700340',
    phoneVerified: true,
    email: 'ali@example.com',
    emailVerified: false,
    avatarUrl: null,
    language: Language.UZ,
    myIdStatus: MyIdStatus.VERIFIED,
    createdAt: new Date('2026-07-01T10:00:00.000Z'),
    updatedAt: new Date('2026-07-20T12:00:00.000Z'),
    ...over,
  };
}

function addressRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'adr_1',
    label: 'Home',
    regionCode: 'TAS',
    district: 'Chilonzor',
    street: 'Bunyodkor 12',
    fullText: 'Tashkent, Chilonzor, Bunyodkor 12',
    lat: 41.3,
    lng: 69.2,
    isDefault: true,
    createdAt: new Date('2026-07-01T10:00:00.000Z'),
    updatedAt: new Date('2026-07-01T10:00:00.000Z'),
    ...over,
  };
}

function vehicleRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'veh_1',
    userId: 'usr_1',
    isPrimary: true,
    nickname: 'Nexia',
    make: { id: 'chevrolet', name: 'Chevrolet', logoUrl: null },
    model: { id: 'nexia', name: 'Nexia 3' },
    year: 2019,
    trim: null,
    engine: null,
    transmission: null,
    drivetrain: null,
    colorHex: null,
    vin: null,
    licensePlate: '01A123BC',
    registrationRegionCode: null,
    mileageKm: 90000,
    fuelType: null,
    model3dAsset: null,
    createdAt: new Date('2026-07-01T10:00:00.000Z'),
    updatedAt: new Date('2026-07-01T10:00:00.000Z'),
    ...over,
  };
}

describe('AdminUsersService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: AdminUsersService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new AdminUsersService(prisma as never);
  });

  describe('list', () => {
    it('returns the {success,data,meta} envelope with correct pagination math', async () => {
      prisma.appUser.findMany.mockResolvedValue([listRow()]);
      prisma.appUser.count.mockResolvedValue(42);

      const res = await service.list({ page: 2, limit: 20 });

      expect(res.success).toBe(true);
      expect(res.meta).toEqual({
        page: 2,
        limit: 20,
        totalItems: 42,
        totalPages: 3,
      });
      // page 2 of 20 -> skip 20
      expect(prisma.appUser.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 20 }),
      );
    });

    it('scopes the query to the USER role so sellers/admins are never listed', async () => {
      prisma.appUser.findMany.mockResolvedValue([]);
      prisma.appUser.count.mockResolvedValue(0);

      await service.list({});

      expect(prisma.appUser.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { role: Role.USER } }),
      );
    });

    it('maps the whitelisted sort field onto the real column', async () => {
      prisma.appUser.findMany.mockResolvedValue([]);
      prisma.appUser.count.mockResolvedValue(0);

      await service.list({ sortBy: 'name', order: 'asc' });

      expect(prisma.appUser.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { displayName: 'asc' } }),
      );
    });

    it('defaults to newest-first when no sort is given', async () => {
      prisma.appUser.findMany.mockResolvedValue([]);
      prisma.appUser.count.mockResolvedValue(0);

      await service.list({});

      expect(prisma.appUser.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { createdAt: 'desc' } }),
      );
    });

    it('searches phones by digits only, so "+" is optional', async () => {
      prisma.appUser.findMany.mockResolvedValue([]);
      prisma.appUser.count.mockResolvedValue(0);

      await service.list({ search: '+998 90 370' });

      const where = prisma.appUser.findMany.mock.calls[0][0].where;
      expect(where.OR).toContainEqual({ phoneE164: { contains: '99890370' } });
    });

    it('does not treat a short numeric term as a phone search', async () => {
      prisma.appUser.findMany.mockResolvedValue([]);
      prisma.appUser.count.mockResolvedValue(0);

      await service.list({ search: '12' });

      const where = prisma.appUser.findMany.mock.calls[0][0].where;
      expect(where.OR).not.toContainEqual(
        expect.objectContaining({ phoneE164: expect.anything() }),
      );
    });

    it('joins per-page spend/last-order in grouped queries, not one per row', async () => {
      prisma.appUser.findMany.mockResolvedValue([
        listRow(),
        listRow({ id: 'usr_2' }),
      ]);
      prisma.appUser.count.mockResolvedValue(2);
      prisma.order.groupBy
        .mockResolvedValueOnce([{ userId: 'usr_1', _sum: { totalUzs: 450000 } }])
        .mockResolvedValueOnce([
          {
            userId: 'usr_1',
            _max: { createdAt: new Date('2026-07-20T10:00:00.000Z') },
          },
        ]);

      const res = await service.list({});

      // Two grouped reads total, regardless of the number of rows on the page.
      expect(prisma.order.groupBy).toHaveBeenCalledTimes(2);
      expect(res.data[0]).toMatchObject({
        id: 'usr_1',
        totalSpent: 450000,
        lastOrderAt: '2026-07-20T10:00:00.000Z',
      });
      // A customer with no orders falls back to zeroes, not undefined.
      expect(res.data[1]).toMatchObject({ totalSpent: 0, lastOrderAt: null });
    });

    it('sums spend only over committed statuses', async () => {
      prisma.appUser.findMany.mockResolvedValue([listRow()]);
      prisma.appUser.count.mockResolvedValue(1);

      await service.list({});

      const spendWhere = prisma.order.groupBy.mock.calls[0][0].where;
      expect(spendWhere.status.in).toEqual([
        OrderStatus.PAID,
        OrderStatus.PROCESSING,
        OrderStatus.SHIPPED,
        OrderStatus.DELIVERED,
      ]);
      expect(spendWhere.status.in).not.toContain(OrderStatus.CANCELLED);
    });

    it('projects the row shape the admin panel expects', async () => {
      prisma.appUser.findMany.mockResolvedValue([listRow()]);
      prisma.appUser.count.mockResolvedValue(1);

      const res = await service.list({});

      expect(res.data[0]).toEqual({
        id: 'usr_1',
        name: 'Ali Valiyev',
        phone: '+998903700340',
        email: 'ali@example.com',
        ordersCount: 3,
        totalSpent: 0,
        lastOrderAt: null,
        createdAt: '2026-07-01T10:00:00.000Z',
      });
    });

    it('falls back to first+last when the display name is absent', async () => {
      prisma.appUser.findMany.mockResolvedValue([
        listRow({ displayName: null }),
      ]);
      prisma.appUser.count.mockResolvedValue(1);

      const res = await service.list({});

      expect(res.data[0].name).toBe('Ali Valiyev');
    });

    it('skips the aggregate reads entirely on an empty page', async () => {
      prisma.appUser.findMany.mockResolvedValue([]);
      prisma.appUser.count.mockResolvedValue(0);

      const res = await service.list({});

      expect(prisma.order.groupBy).not.toHaveBeenCalled();
      expect(res.data).toEqual([]);
    });
  });

  describe('getOne', () => {
    it('404s for an unknown customer', async () => {
      prisma.appUser.findFirst.mockResolvedValue(null);

      await expect(service.getOne('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('404s for a non-USER account rather than exposing it', async () => {
      prisma.appUser.findFirst.mockResolvedValue(null);

      await expect(service.getOne('usr_seller')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.appUser.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'usr_seller', role: Role.USER },
        }),
      );
    });

    it('returns the profile and order summary', async () => {
      prisma.appUser.findFirst.mockResolvedValue(detailRow());
      prisma.order.count.mockResolvedValue(5);
      prisma.order.aggregate.mockResolvedValue({
        _sum: { totalUzs: 450000 },
      });
      prisma.order.findFirst.mockResolvedValue({
        createdAt: new Date('2026-07-20T10:00:00.000Z'),
      });

      const res = await service.getOne('usr_1');

      expect(res.success).toBe(true);
      expect(res.data).toMatchObject({
        id: 'usr_1',
        name: 'Ali Valiyev',
        firstName: 'Ali',
        lastName: 'Valiyev',
        phone: '+998903700340',
        phoneVerified: true,
        email: 'ali@example.com',
        emailVerified: false,
        language: 'uz',
        myIdStatus: 'verified',
        stats: {
          totalOrders: 5,
          totalSpent: 450000,
          lastOrderAt: '2026-07-20T10:00:00.000Z',
        },
      });
    });

    // The whole point of the resource split: the profile stays lightweight.
    it('does NOT embed addresses or recentOrders', async () => {
      prisma.appUser.findFirst.mockResolvedValue(detailRow());

      const res = await service.getOne('usr_1');

      expect(res.data).not.toHaveProperty('addresses');
      expect(res.data).not.toHaveProperty('recentOrders');
    });

    it('does not read addresses or vehicles while building the profile', async () => {
      prisma.appUser.findFirst.mockResolvedValue(detailRow());

      await service.getOne('usr_1');

      expect(prisma.address.findMany).not.toHaveBeenCalled();
      expect(prisma.vehicle.findMany).not.toHaveBeenCalled();
    });

    it('never leaks credential material', async () => {
      prisma.appUser.findFirst.mockResolvedValue(detailRow());

      const res = await service.getOne('usr_1');

      expect(res.data).not.toHaveProperty('passwordHash');
      expect(res.data).not.toHaveProperty('tokenVersion');
    });

    it('reports zero spend for a user with no committed orders', async () => {
      prisma.appUser.findFirst.mockResolvedValue(detailRow());

      const res = await service.getOne('usr_1');

      expect(res.data.stats).toEqual({
        totalOrders: 0,
        totalSpent: 0,
        lastOrderAt: null,
      });
    });
  });

  describe('listAddresses', () => {
    it('404s for a non-customer instead of returning an empty list', async () => {
      prisma.appUser.findFirst.mockResolvedValue(null);

      await expect(service.listAddresses('usr_seller')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.address.findMany).not.toHaveBeenCalled();
    });

    it('returns the addresses, default first', async () => {
      prisma.appUser.findFirst.mockResolvedValue({ id: 'usr_1' });
      prisma.address.findMany.mockResolvedValue([addressRow()]);

      const res = await service.listAddresses('usr_1');

      expect(res.success).toBe(true);
      expect(res.data[0]).toEqual({
        id: 'adr_1',
        label: 'Home',
        city: 'TAS',
        district: 'Chilonzor',
        street: 'Bunyodkor 12',
        addressLine: 'Tashkent, Chilonzor, Bunyodkor 12',
        location: { lat: 41.3, lng: 69.2 },
        isDefault: true,
        createdAt: '2026-07-01T10:00:00.000Z',
        updatedAt: '2026-07-01T10:00:00.000Z',
      });
      expect(prisma.address.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'usr_1' },
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
        }),
      );
    });

    it('nulls the location when coordinates are missing', async () => {
      prisma.appUser.findFirst.mockResolvedValue({ id: 'usr_1' });
      prisma.address.findMany.mockResolvedValue([
        addressRow({ lat: null, lng: null }),
      ]);

      const res = await service.listAddresses('usr_1');

      expect(res.data[0].location).toBeNull();
    });

    it('returns an empty list for a customer with no addresses', async () => {
      prisma.appUser.findFirst.mockResolvedValue({ id: 'usr_1' });
      prisma.address.findMany.mockResolvedValue([]);

      const res = await service.listAddresses('usr_1');

      expect(res.data).toEqual([]);
    });
  });

  describe('listVehicles', () => {
    it('404s for a non-customer instead of returning an empty list', async () => {
      prisma.appUser.findFirst.mockResolvedValue(null);

      await expect(service.listVehicles('usr_seller')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.vehicle.findMany).not.toHaveBeenCalled();
    });

    it('excludes soft-deleted vehicles, primary first', async () => {
      prisma.appUser.findFirst.mockResolvedValue({ id: 'usr_1' });
      prisma.vehicle.findMany.mockResolvedValue([vehicleRow()]);

      await service.listVehicles('usr_1');

      expect(prisma.vehicle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'usr_1', deletedAt: null },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }],
        }),
      );
    });

    // Admin responses are camelCase across the board; the snake_case mobile
    // contract must not leak through this endpoint.
    it('projects vehicles in the admin camelCase vocabulary', async () => {
      prisma.appUser.findFirst.mockResolvedValue({ id: 'usr_1' });
      prisma.vehicle.findMany.mockResolvedValue([vehicleRow()]);

      const res = await service.listVehicles('usr_1');

      expect(res.success).toBe(true);
      expect(res.data[0]).toMatchObject({
        id: 'veh_1',
        userId: 'usr_1',
        isPrimary: true,
        nickname: 'Nexia',
        make: { id: 'chevrolet', name: 'Chevrolet', logoUrl: null },
        model: { id: 'nexia', name: 'Nexia 3' },
        year: 2019,
        licensePlate: '01A123BC',
        mileageKm: 90000,
        model3d: null,
        createdAt: '2026-07-01T10:00:00.000Z',
        updatedAt: '2026-07-01T10:00:00.000Z',
      });
    });

    it('emits no snake_case keys at any level', async () => {
      prisma.appUser.findFirst.mockResolvedValue({ id: 'usr_1' });
      prisma.vehicle.findMany.mockResolvedValue([
        vehicleRow({
          engine: {
            id: 'eng_1',
            name: '1.5 DOHC',
            displacementCc: 1485,
            fuelType: 'PETROL',
          },
          model3dAsset: {
            glbUrl: 'https://cdn/x.glb',
            ktx2TexturesUrl: null,
            version: 2,
            byteSize: 1024,
            checksumSha256: 'abc',
            variants: [
              { id: 'tv_1', name: 'Sport', thumbnailUrl: 'https://cdn/t.png' },
            ],
          },
        }),
      ]);

      const res = await service.listVehicles('usr_1');

      const snakeKeys: string[] = [];
      const walk = (node: unknown) => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (node && typeof node === 'object') {
          for (const [k, v] of Object.entries(node)) {
            if (k.includes('_')) snakeKeys.push(k);
            walk(v);
          }
        }
      };
      walk(res.data);
      expect(snakeKeys).toEqual([]);
    });

    it('keeps enum values lowercased, as the garage presenter does', async () => {
      prisma.appUser.findFirst.mockResolvedValue({ id: 'usr_1' });
      prisma.vehicle.findMany.mockResolvedValue([
        vehicleRow({
          transmission: 'AUTOMATIC',
          drivetrain: 'FWD',
          fuelType: 'PETROL',
        }),
      ]);

      const res = await service.listVehicles('usr_1');

      expect(res.data[0]).toMatchObject({
        transmission: 'automatic',
        drivetrain: 'fwd',
        fuelType: 'petrol',
      });
    });

    it('maps the 3d asset and its tuning variants', async () => {
      prisma.appUser.findFirst.mockResolvedValue({ id: 'usr_1' });
      prisma.vehicle.findMany.mockResolvedValue([
        vehicleRow({
          model3dAsset: {
            glbUrl: 'https://cdn/x.glb',
            ktx2TexturesUrl: 'https://cdn/x.ktx2',
            version: 2,
            byteSize: 1024,
            checksumSha256: 'abc',
            variants: [
              { id: 'tv_1', name: 'Sport', thumbnailUrl: 'https://cdn/t.png' },
            ],
          },
        }),
      ]);

      const res = await service.listVehicles('usr_1');

      expect(res.data[0].model3d).toEqual({
        glbUrl: 'https://cdn/x.glb',
        ktx2TexturesUrl: 'https://cdn/x.ktx2',
        tuningVariants: [
          { id: 'tv_1', name: 'Sport', thumbnailUrl: 'https://cdn/t.png' },
        ],
        version: 2,
        byteSize: 1024,
        checksumSha256: 'abc',
      });
    });
  });
});

describe('ListAdminUsersQueryDto', () => {
  it('rejects a sort field that is not whitelisted', () => {
    const dto = plainToInstance(ListAdminUsersQueryDto, {
      sortBy: 'passwordHash',
    });
    const errors = validateSync(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('sortBy');
  });

  it('rejects an unknown order direction', () => {
    const dto = plainToInstance(ListAdminUsersQueryDto, { order: 'sideways' });
    expect(validateSync(dto)).toHaveLength(1);
  });

  it('accepts a valid query', () => {
    const dto = plainToInstance(ListAdminUsersQueryDto, {
      page: 1,
      limit: 20,
      sortBy: 'createdAt',
      order: 'desc',
      search: 'ali',
    });
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('rejects a limit above the ceiling', () => {
    const dto = plainToInstance(ListAdminUsersQueryDto, { limit: 500 });
    expect(validateSync(dto)).toHaveLength(1);
  });
});
