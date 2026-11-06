// Unit tests for the admin dealers console (/v1/admin/dealers). Prisma and the
// audit service are mocked — no DB. These guard: pagination meta + offset math,
// the whitelisted sort mapping (including the relation-count sort for `skus`),
// the status filter, search across name/city/email/phone, the row/detail
// presenter shapes (integer UZS out of a BigInt column, lowercased status), the
// state machine (legal transitions and the 400s), suspension-reason persistence
// and clearing, and that EVERY mutation writes an audit entry inside the same
// transaction with the right verb and before/after values. A separate block
// validates the DTOs reject bad input (400).

import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  AdminAuditAction,
  AdminAuditEntity,
  DealerStatus,
} from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AdminDealersService } from './admin-dealers.service';
import { CreateAdminDealerDto } from './dto/create-admin-dealer.dto';
import { ListAdminDealersQueryDto } from './dto/list-admin-dealers.query.dto';
import {
  SuspendAdminDealerDto,
  UpdateAdminDealerDto,
} from './dto/update-admin-dealer.dto';

function makePrismaMock() {
  const catalogSeller = {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  };
  const seller = {
    findMany: jest.fn().mockResolvedValue([]),
    update: jest.fn(),
  };
  const prisma: Record<string, unknown> = { catalogSeller, seller };
  // Array form runs the (already-invoked) query promises; callback form gets the
  // mock itself, so the service's `tx` IS this same mock and assertions on
  // catalogSeller.update also cover the transactional path.
  prisma.$transaction = (arg: unknown) =>
    Array.isArray(arg)
      ? Promise.all(arg)
      : (arg as (tx: unknown) => unknown)(prisma);
  return prisma as {
    catalogSeller: typeof catalogSeller;
    seller: typeof seller;
    $transaction: (arg: unknown) => unknown;
  };
}

function makeAuditMock() {
  return { record: jest.fn().mockResolvedValue(undefined) };
}

/** A row as ADMIN_DEALER_LIST_SELECT returns it. */
function listRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'd1',
    name: 'AutoPro Parts',
    city: 'Tashkent',
    brandColor: '#2A6FDB',
    color: '#2A6FDB',
    gmvUzs: BigInt(5180000000),
    ordersCount: 18400,
    certified: true,
    lowestPrice: false,
    status: DealerStatus.ACTIVE,
    joinedAt: new Date('2026-01-10T10:00:00.000Z'),
    updatedAt: new Date('2026-07-20T11:00:00.000Z'),
    _count: { parts: 1284 },
    ...over,
  };
}

/** A row as ADMIN_DEALER_DETAIL_SELECT returns it. */
function detailRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    ...listRow(),
    email: 'sales@autopro.uz',
    phoneE164: '+998903700340',
    logoUrl: 'https://cdn.mator.uz/d1.png',
    ratingAvg: 4.8,
    years: 12,
    isCurated: true,
    suspendedReason: null,
    // Налоговые данные — unconfigured by default, the state every dealer
    // starts in and the one that blocks Payme checkout.
    tin: null,
    vatPercent: null,
    ...over,
  };
}

/** The row shape requireDealer() selects inside a mutation. */
function mutableRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'd1',
    name: 'AutoPro Parts',
    status: DealerStatus.PENDING,
    certified: false,
    lowestPrice: false,
    tin: null,
    vatPercent: null,
    ...over,
  };
}

const CTX = {
  actor: { id: 'adm_1', email: 'ops@mator.uz', name: 'Ops Admin' },
  ip: '10.0.0.1',
  userAgent: 'console/1.0',
};

describe('AdminDealersService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let audit: ReturnType<typeof makeAuditMock>;
  let service: AdminDealersService;

  beforeEach(() => {
    prisma = makePrismaMock();
    audit = makeAuditMock();
    service = new AdminDealersService(
      prisma as never,
      audit as never,
      { uploadBuffer: jest.fn() } as never,
    );
  });

  describe('list', () => {
    it('returns the standard envelope with correct pagination meta', async () => {
      prisma.catalogSeller.findMany.mockResolvedValue([listRow()]);
      prisma.catalogSeller.count.mockResolvedValue(6);

      const res = await service.list({ page: 1, limit: 100 });

      expect(res.success).toBe(true);
      expect(res.meta).toEqual({
        page: 1,
        limit: 100,
        totalItems: 6,
        totalPages: 1,
      });
      expect(res.data).toHaveLength(1);
    });

    it('projects the documented row shape, with integer UZS and lowercase status', async () => {
      prisma.catalogSeller.findMany.mockResolvedValue([listRow()]);
      prisma.catalogSeller.count.mockResolvedValue(1);

      const [row] = (await service.list({})).data;

      expect(row).toEqual({
        id: 'd1',
        name: 'AutoPro Parts',
        city: 'Tashkent',
        brandColor: '#2A6FDB',
        gmvUzs: 5180000000,
        orders: 18400,
        skus: 1284,
        certified: true,
        lowestPrice: false,
        status: 'active',
        joinedAt: '2026-01-10T10:00:00.000Z',
        updatedAt: '2026-07-20T11:00:00.000Z',
      });
      // A BigInt would break JSON.stringify; it must leave as a JS number.
      expect(typeof row.gmvUzs).toBe('number');
    });

    it('falls back to the legacy storefront color when brandColor is unset', async () => {
      prisma.catalogSeller.findMany.mockResolvedValue([
        listRow({ brandColor: null, color: '#FF8A00' }),
      ]);
      prisma.catalogSeller.count.mockResolvedValue(1);

      const [row] = (await service.list({})).data;
      expect(row.brandColor).toBe('#FF8A00');
    });

    it('defaults to newest-first with a total order, and offsets by page', async () => {
      prisma.catalogSeller.findMany.mockResolvedValue([]);
      prisma.catalogSeller.count.mockResolvedValue(0);

      await service.list({ page: 3, limit: 20 });

      const args = prisma.catalogSeller.findMany.mock.calls[0][0];
      expect(args.orderBy).toEqual([{ joinedAt: 'desc' }, { id: 'asc' }]);
      expect(args.skip).toBe(40);
      expect(args.take).toBe(20);
    });

    it('maps each whitelisted sort field onto its real column', async () => {
      prisma.catalogSeller.findMany.mockResolvedValue([]);
      prisma.catalogSeller.count.mockResolvedValue(0);

      await service.list({ sort: 'gmvUzs', order: 'asc' });
      expect(
        prisma.catalogSeller.findMany.mock.calls[0][0].orderBy[0],
      ).toEqual({ gmvUzs: 'asc' });

      await service.list({ sort: 'orders', order: 'desc' });
      expect(
        prisma.catalogSeller.findMany.mock.calls[1][0].orderBy[0],
      ).toEqual({ ordersCount: 'desc' });

      await service.list({ sort: 'name', order: 'asc' });
      expect(
        prisma.catalogSeller.findMany.mock.calls[2][0].orderBy[0],
      ).toEqual({ name: 'asc' });
    });

    it('sorts skus by the relation count, not a scalar column', async () => {
      prisma.catalogSeller.findMany.mockResolvedValue([]);
      prisma.catalogSeller.count.mockResolvedValue(0);

      await service.list({ sort: 'skus', order: 'desc' });

      expect(
        prisma.catalogSeller.findMany.mock.calls[0][0].orderBy[0],
      ).toEqual({ parts: { _count: 'desc' } });
    });

    it('filters by status using the real enum', async () => {
      prisma.catalogSeller.findMany.mockResolvedValue([]);
      prisma.catalogSeller.count.mockResolvedValue(0);

      await service.list({ status: 'suspended' });

      expect(prisma.catalogSeller.findMany.mock.calls[0][0].where).toEqual({
        status: DealerStatus.SUSPENDED,
      });
    });

    it('searches name, city and email, and phone only past the digit threshold', async () => {
      prisma.catalogSeller.findMany.mockResolvedValue([]);
      prisma.catalogSeller.count.mockResolvedValue(0);

      await service.list({ search: 'Auto' });
      const textOnly = prisma.catalogSeller.findMany.mock.calls[0][0].where.OR;
      expect(textOnly).toEqual([
        { name: { contains: 'Auto', mode: 'insensitive' } },
        { city: { contains: 'Auto', mode: 'insensitive' } },
        { email: { contains: 'Auto', mode: 'insensitive' } },
      ]);

      // A '+'-prefixed number is matched digit-only against the E.164 column.
      await service.list({ search: '+99890370' });
      const withPhone = prisma.catalogSeller.findMany.mock.calls[1][0].where.OR;
      expect(withPhone).toContainEqual({ phoneE164: { contains: '99890370' } });
    });

    it('clamps an over-large limit rather than trusting the query', async () => {
      prisma.catalogSeller.findMany.mockResolvedValue([]);
      prisma.catalogSeller.count.mockResolvedValue(0);

      const res = await service.list({ limit: 5000 });

      expect(res.meta.limit).toBe(100);
      expect(prisma.catalogSeller.findMany.mock.calls[0][0].take).toBe(100);
    });
  });

  describe('create', () => {
    it('creates a curated, ACTIVE, certified dealer that shows in the app', async () => {
      // uniqueDealerId probes for a collision (none), then getOne re-reads the row.
      prisma.catalogSeller.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(detailRow());

      await service.create(
        { name: 'BYD Motors', brandColor: '#2A6FDB', logoUrl: 'https://res.cloudinary.com/mator/image/upload/x.png' },
        CTX as never,
      );

      expect(prisma.catalogSeller.create).toHaveBeenCalledTimes(1);
      const data = prisma.catalogSeller.create.mock.calls[0][0].data;
      // Curated + ACTIVE + certified are exactly the three conditions
      // GET /v1/dealers filters on, so the new dealer is live immediately.
      expect(data).toMatchObject({
        id: 'byd-motors',
        name: 'BYD Motors',
        isCurated: true,
        status: DealerStatus.ACTIVE,
        certified: true,
        // brandColor and the legacy storefront `color` both set on create.
        brandColor: '#2A6FDB',
        color: '#2A6FDB',
        // initial derived from the name when not supplied.
        initial: 'B',
        logoUrl: 'https://res.cloudinary.com/mator/image/upload/x.png',
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AdminAuditAction.DEALER_CREATED }),
        expect.anything(),
      );
    });

    it('never certifies a dealer created in a non-active state', async () => {
      prisma.catalogSeller.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(detailRow());

      await service.create(
        { name: 'Pending Co', status: 'pending', certified: true },
        CTX as never,
      );

      const data = prisma.catalogSeller.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        status: DealerStatus.PENDING,
        certified: false,
        lowestPrice: false,
      });
    });
  });

  describe('getOne', () => {
    it('returns the detail shape as a superset of the list row', async () => {
      prisma.catalogSeller.findUnique.mockResolvedValue(detailRow());

      const { data } = await service.getOne('d1');

      // Every list field is still present and unchanged...
      expect(data).toMatchObject({
        id: 'd1',
        name: 'AutoPro Parts',
        gmvUzs: 5180000000,
        orders: 18400,
        skus: 1284,
        status: 'active',
      });
      // ...plus the richer detail-only fields.
      expect(data).toMatchObject({
        email: 'sales@autopro.uz',
        phone: '+998903700340',
        rating: 4.8,
        years: 12,
      });
    });

    it('hides a stale suspension reason on a non-suspended dealer', async () => {
      prisma.catalogSeller.findUnique.mockResolvedValue(
        detailRow({ status: DealerStatus.ACTIVE, suspendedReason: 'old' }),
      );

      const { data } = await service.getOne('d1');
      expect(data.suspendedReason).toBeNull();
    });

    it('surfaces the reason while suspended', async () => {
      prisma.catalogSeller.findUnique.mockResolvedValue(
        detailRow({
          status: DealerStatus.SUSPENDED,
          suspendedReason: 'Manual moderation',
        }),
      );

      const { data } = await service.getOne('d1');
      expect(data.suspendedReason).toBe('Manual moderation');
    });

    it('404s on an unknown id', async () => {
      prisma.catalogSeller.findUnique.mockResolvedValue(null);
      await expect(service.getOne('nope')).rejects.toThrow(NotFoundException);
    });
  });

  describe('approve', () => {
    it('moves pending -> active and audits it', async () => {
      prisma.catalogSeller.findUnique
        .mockResolvedValueOnce(mutableRow({ status: DealerStatus.PENDING }))
        .mockResolvedValueOnce(detailRow({ status: DealerStatus.ACTIVE }));

      await service.approve('d1', CTX);

      expect(prisma.catalogSeller.update).toHaveBeenCalledWith({
        where: { id: 'd1' },
        data: { status: DealerStatus.ACTIVE, suspendedReason: null },
      });

      const [entry, tx] = audit.record.mock.calls[0];
      expect(entry.action).toBe(AdminAuditAction.DEALER_APPROVED);
      expect(entry.target).toEqual({
        entity: AdminAuditEntity.DEALER,
        id: 'd1',
        name: 'AutoPro Parts',
      });
      expect(entry.previousValues).toEqual({ status: DealerStatus.PENDING });
      expect(entry.newValues).toEqual({ status: DealerStatus.ACTIVE });
      expect(entry.actor).toEqual(CTX.actor);
      // Written in the caller's transaction, so the change and its audit entry
      // commit together.
      expect(tx).toBe(prisma);
    });

    it('rejects approving a dealer that is not pending', async () => {
      prisma.catalogSeller.findUnique.mockResolvedValue(
        mutableRow({ status: DealerStatus.ACTIVE }),
      );

      await expect(service.approve('d1', CTX)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.catalogSeller.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('404s on an unknown id', async () => {
      prisma.catalogSeller.findUnique.mockResolvedValue(null);
      await expect(service.approve('nope', CTX)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('suspend', () => {
    it('moves active -> suspended, persisting and auditing the reason', async () => {
      prisma.catalogSeller.findUnique
        .mockResolvedValueOnce(mutableRow({ status: DealerStatus.ACTIVE }))
        .mockResolvedValueOnce(detailRow({ status: DealerStatus.SUSPENDED }));

      await service.suspend('d1', CTX, '  Manual moderation  ');

      expect(prisma.catalogSeller.update).toHaveBeenCalledWith({
        where: { id: 'd1' },
        data: {
          status: DealerStatus.SUSPENDED,
          suspendedReason: 'Manual moderation',
        },
      });
      const [entry] = audit.record.mock.calls[0];
      expect(entry.action).toBe(AdminAuditAction.DEALER_SUSPENDED);
      expect(entry.reason).toBe('Manual moderation');
    });

    it('suspends without a reason', async () => {
      prisma.catalogSeller.findUnique
        .mockResolvedValueOnce(mutableRow({ status: DealerStatus.ACTIVE }))
        .mockResolvedValueOnce(detailRow({ status: DealerStatus.SUSPENDED }));

      await service.suspend('d1', CTX);

      expect(
        prisma.catalogSeller.update.mock.calls[0][0].data.suspendedReason,
      ).toBeNull();
    });

    it('rejects suspending a pending dealer', async () => {
      prisma.catalogSeller.findUnique.mockResolvedValue(
        mutableRow({ status: DealerStatus.PENDING }),
      );

      await expect(service.suspend('d1', CTX)).rejects.toThrow(
        BadRequestException,
      );
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('reactivate', () => {
    it('moves suspended -> active, clears the reason, and audits REACTIVATED', async () => {
      prisma.catalogSeller.findUnique
        .mockResolvedValueOnce(mutableRow({ status: DealerStatus.SUSPENDED }))
        .mockResolvedValueOnce(detailRow({ status: DealerStatus.ACTIVE }));

      await service.reactivate('d1', CTX);

      expect(prisma.catalogSeller.update).toHaveBeenCalledWith({
        where: { id: 'd1' },
        data: { status: DealerStatus.ACTIVE, suspendedReason: null },
      });
      // Distinct from an approval even though both land on ACTIVE.
      expect(audit.record.mock.calls[0][0].action).toBe(
        AdminAuditAction.DEALER_REACTIVATED,
      );
    });

    it('rejects reactivating a dealer that is not suspended', async () => {
      prisma.catalogSeller.findUnique.mockResolvedValue(
        mutableRow({ status: DealerStatus.ACTIVE }),
      );

      await expect(service.reactivate('d1', CTX)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('pickup location', () => {
    const linked = (over: Record<string, unknown> = {}) => ({
      id: 7,
      catalogSellerId: 'd1',
      locationLat: null,
      locationLng: null,
      ...over,
    });
    const editing = () =>
      prisma.catalogSeller.findUnique
        .mockResolvedValueOnce(mutableRow({ internalSellerId: null }))
        .mockResolvedValueOnce(detailRow({ internalSellerId: null }));

    it('getOne shows where it stands, null when unset', async () => {
      prisma.catalogSeller.findUnique.mockResolvedValue(detailRow());
      prisma.seller.findMany.mockResolvedValue([]);
      await expect(service.getOne('d1')).resolves.toMatchObject({
        data: { pickupLat: null, pickupLng: null },
      });

      prisma.seller.findMany.mockResolvedValue([
        linked({ locationLat: 41.3, locationLng: 69.2 }),
      ]);
      await expect(service.getOne('d1')).resolves.toMatchObject({
        data: { pickupLat: 41.3, pickupLng: 69.2 },
      });
    });

    it('is written to the supply-side seller, audited in the same transaction', async () => {
      editing();
      prisma.seller.findMany.mockResolvedValue([linked()]);

      await service.update('d1', { pickupLat: 41.31, pickupLng: 69.28 }, CTX);

      expect(prisma.seller.update).toHaveBeenCalledWith({
        where: { id: 7 },
        data: { locationLat: 41.31, locationLng: 69.28 },
      });
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record.mock.calls[0][0]).toMatchObject({
        action: AdminAuditAction.DEALER_UPDATED,
        previousValues: { pickup: { lat: null, lng: null } },
        newValues: { pickup: { lat: 41.31, lng: 69.28 } },
      });
    });

    it('also finds the seller a projected storefront recorded', async () => {
      prisma.catalogSeller.findUnique
        .mockResolvedValueOnce(mutableRow({ internalSellerId: 12 }))
        .mockResolvedValueOnce(detailRow({ internalSellerId: 12 }));
      prisma.seller.findMany.mockResolvedValue([linked({ id: 12, catalogSellerId: null })]);

      await service.update('d1', { pickupLat: 41.31, pickupLng: 69.28 }, CTX);

      expect(prisma.seller.update.mock.calls[0][0].where).toEqual({ id: 12 });
      expect(prisma.seller.findMany.mock.calls[0][0].where).toEqual({
        OR: [{ catalogSellerId: 'd1' }, { id: 12 }],
      });
    });

    it('setting the value it already holds writes nothing and audits nothing', async () => {
      editing();
      prisma.seller.findMany.mockResolvedValue([
        linked({ locationLat: 41.31, locationLng: 69.28 }),
      ]);

      await service.update('d1', { pickupLat: 41.31, pickupLng: 69.28 }, CTX);

      expect(prisma.seller.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it.each([
      ['half a pair', { pickupLat: 41.31 }],
      ['the other half', { pickupLng: 69.28 }],
      ['0,0, which is no place', { pickupLat: 0, pickupLng: 0 }],
    ])('refuses %s', async (_, body) => {
      prisma.catalogSeller.findUnique.mockResolvedValueOnce(
        mutableRow({ internalSellerId: null }),
      );

      await expect(service.update('d1', body, CTX)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.seller.update).not.toHaveBeenCalled();
    });

    it('refuses a dealer with no supply-side seller instead of inventing one', async () => {
      prisma.catalogSeller.findUnique.mockResolvedValueOnce(
        mutableRow({ internalSellerId: null }),
      );
      prisma.seller.findMany.mockResolvedValue([]);

      await expect(
        service.update('d1', { pickupLat: 41.31, pickupLng: 69.28 }, CTX),
      ).rejects.toThrow(/no supply-side seller/);
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('rejects an empty body', async () => {
      await expect(service.update('d1', {}, CTX)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.catalogSeller.update).not.toHaveBeenCalled();
    });

    it('suspending through PATCH revokes the badges, as POST /:id/suspend does', async () => {
      prisma.catalogSeller.findUnique
        .mockResolvedValueOnce(
          mutableRow({
            status: DealerStatus.ACTIVE,
            certified: true,
            lowestPrice: true,
          }),
        )
        .mockResolvedValueOnce(detailRow());

      await service.update('d1', { status: 'suspended', reason: 'x' }, CTX);

      expect(prisma.catalogSeller.update).toHaveBeenCalledWith({
        where: { id: 'd1' },
        data: expect.objectContaining({
          status: DealerStatus.SUSPENDED,
          certified: false,
          lowestPrice: false,
        }),
      });
    });

    it('refuses a badge on a suspended dealer', async () => {
      prisma.catalogSeller.findUnique.mockResolvedValueOnce(
        mutableRow({ status: DealerStatus.SUSPENDED, certified: false }),
      );

      await expect(
        service.update('d1', { certified: true }, CTX),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.catalogSeller.update).not.toHaveBeenCalled();
    });

    it('a null tin clears it instead of crashing', async () => {
      prisma.catalogSeller.findUnique
        .mockResolvedValueOnce(mutableRow({ tin: '301234567' }))
        .mockResolvedValueOnce(detailRow());

      await service.update('d1', { tin: null }, CTX);

      expect(prisma.catalogSeller.update).toHaveBeenCalledWith({
        where: { id: 'd1' },
        data: { tin: null },
      });
    });

    it('flips a badge and audits the specific verb', async () => {
      prisma.catalogSeller.findUnique
        .mockResolvedValueOnce(mutableRow({ certified: false }))
        .mockResolvedValueOnce(detailRow());

      await service.update('d1', { certified: true }, CTX);

      expect(prisma.catalogSeller.update).toHaveBeenCalledWith({
        where: { id: 'd1' },
        data: { certified: true },
      });
      const [entry] = audit.record.mock.calls[0];
      expect(entry.action).toBe(AdminAuditAction.DEALER_CERTIFIED_ENABLED);
      expect(entry.previousValues).toEqual({ certified: false });
      expect(entry.newValues).toEqual({ certified: true });
    });

    it('audits the disable verb when a badge is turned off', async () => {
      prisma.catalogSeller.findUnique
        .mockResolvedValueOnce(mutableRow({ lowestPrice: true }))
        .mockResolvedValueOnce(detailRow());

      await service.update('d1', { lowestPrice: false }, CTX);

      expect(audit.record.mock.calls[0][0].action).toBe(
        AdminAuditAction.DEALER_LOWEST_PRICE_DISABLED,
      );
    });

    it('writes one audit entry per changed field', async () => {
      prisma.catalogSeller.findUnique
        .mockResolvedValueOnce(
          mutableRow({ certified: false, lowestPrice: false }),
        )
        .mockResolvedValueOnce(detailRow());

      await service.update('d1', { certified: true, lowestPrice: true }, CTX);

      expect(prisma.catalogSeller.update).toHaveBeenCalledWith({
        where: { id: 'd1' },
        data: { certified: true, lowestPrice: true },
      });
      expect(audit.record).toHaveBeenCalledTimes(2);
      expect(audit.record.mock.calls.map((c) => c[0].action)).toEqual([
        AdminAuditAction.DEALER_CERTIFIED_ENABLED,
        AdminAuditAction.DEALER_LOWEST_PRICE_ENABLED,
      ]);
    });

    it('does not write or audit when a field already holds the requested value', async () => {
      prisma.catalogSeller.findUnique
        .mockResolvedValueOnce(mutableRow({ certified: true }))
        .mockResolvedValueOnce(detailRow());

      await service.update('d1', { certified: true }, CTX);

      expect(prisma.catalogSeller.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('routes a status change through the same transition rules', async () => {
      prisma.catalogSeller.findUnique.mockResolvedValue(
        mutableRow({ status: DealerStatus.PENDING }),
      );

      // PENDING -> SUSPENDED is not a legal transition, even via PATCH.
      await expect(
        service.update('d1', { status: 'suspended' }, CTX),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.catalogSeller.update).not.toHaveBeenCalled();
    });

    it('applies a legal status change and audits it', async () => {
      prisma.catalogSeller.findUnique
        .mockResolvedValueOnce(mutableRow({ status: DealerStatus.PENDING }))
        .mockResolvedValueOnce(detailRow({ status: DealerStatus.ACTIVE }));

      await service.update('d1', { status: 'active' }, CTX);

      expect(prisma.catalogSeller.update).toHaveBeenCalledWith({
        where: { id: 'd1' },
        data: { status: DealerStatus.ACTIVE, suspendedReason: null },
      });
      expect(audit.record.mock.calls[0][0].action).toBe(
        AdminAuditAction.DEALER_APPROVED,
      );
    });

    it('404s on an unknown id', async () => {
      prisma.catalogSeller.findUnique.mockResolvedValue(null);
      await expect(
        service.update('nope', { certified: true }, CTX),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── Налоговые данные ──────────────────────────────────────────────────────
  // ИНН/ПИНФЛ and the VAT rate live on the dealer, are set only here (no
  // automatic lookup, no Telegram question), and are what every Payme receipt
  // of this dealer's products is built from.
  describe('tax data', () => {
    it('saves the TIN', async () => {
      prisma.catalogSeller.findUnique
        .mockResolvedValueOnce(mutableRow())
        .mockResolvedValueOnce(detailRow());

      await service.update('d1', { tin: '301234567' }, CTX);

      expect(prisma.catalogSeller.update).toHaveBeenCalledWith({
        where: { id: 'd1' },
        data: { tin: '301234567' },
      });
    });

    it('saves the VAT percentage, including an explicit 0', async () => {
      prisma.catalogSeller.findUnique
        .mockResolvedValueOnce(mutableRow())
        .mockResolvedValueOnce(detailRow());

      await service.update('d1', { vatPercent: 0 }, CTX);

      // 0 is a RATE the operator chose, not a missing value: it must be
      // written, and it must not be mistaken for "nothing to update".
      expect(prisma.catalogSeller.update).toHaveBeenCalledWith({
        where: { id: 'd1' },
        data: { vatPercent: 0 },
      });
    });

    it('updates an existing VAT percentage', async () => {
      prisma.catalogSeller.findUnique
        .mockResolvedValueOnce(mutableRow({ vatPercent: 0 }))
        .mockResolvedValueOnce(detailRow());

      await service.update('d1', { vatPercent: 12 }, CTX);

      expect(prisma.catalogSeller.update).toHaveBeenCalledWith({
        where: { id: 'd1' },
        data: { vatPercent: 12 },
      });
    });

    it('changing the rate re-prices nothing: only the dealer row is written', async () => {
      // The rate is a label for the receipt. Catalog prices already include VAT, so
      // neither direction may reach a part, a stock, a listing, a cart or an order.
      const writes = ['create', 'createMany', 'update', 'updateMany', 'upsert'];
      const models = [
        'catalogPart',
        'stock',
        'product',
        'cartItem',
        'order',
        'orderItem',
      ];
      const priced = Object.fromEntries(
        models.map((model) => [
          model,
          Object.fromEntries(writes.map((write) => [write, jest.fn()])),
        ]),
      );
      Object.assign(prisma, priced);

      for (const [from, to] of [
        [0, 12],
        [12, 0],
      ]) {
        prisma.catalogSeller.update.mockClear();
        prisma.catalogSeller.findUnique
          .mockResolvedValueOnce(mutableRow({ vatPercent: from }))
          .mockResolvedValueOnce(detailRow());

        await service.update('d1', { vatPercent: to }, CTX);

        expect(prisma.catalogSeller.update).toHaveBeenCalledTimes(1);
        expect(prisma.catalogSeller.update).toHaveBeenCalledWith({
          where: { id: 'd1' },
          data: { vatPercent: to },
        });
      }
      for (const model of Object.values(priced)) {
        for (const write of Object.values(model)) {
          expect(write).not.toHaveBeenCalled();
        }
      }
      expect(prisma.seller.update).not.toHaveBeenCalled();
    });

    it('audits both fields together, with before and after values', async () => {
      prisma.catalogSeller.findUnique
        .mockResolvedValueOnce(mutableRow({ tin: null, vatPercent: null }))
        .mockResolvedValueOnce(detailRow());

      await service.update('d1', { tin: '301234567', vatPercent: 12 }, CTX);

      const [entry] = audit.record.mock.calls[0];
      expect(entry.action).toBe(AdminAuditAction.DEALER_UPDATED);
      expect(entry.previousValues).toEqual({ tin: null, vatPercent: null });
      expect(entry.newValues).toEqual({ tin: '301234567', vatPercent: 12 });
    });

    it('writes nothing when the values already hold (Decimal compared as a number)', async () => {
      prisma.catalogSeller.findUnique
        .mockResolvedValueOnce(
          // Prisma hands back a Decimal; comparing it to 12 by identity would
          // report a change on every save.
          mutableRow({ tin: '301234567', vatPercent: { toString: () => '12' } }),
        )
        .mockResolvedValueOnce(detailRow());

      await service.update('d1', { tin: '301234567', vatPercent: 12 }, CTX);

      expect(prisma.catalogSeller.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('clears the TIN on an empty string', async () => {
      prisma.catalogSeller.findUnique
        .mockResolvedValueOnce(mutableRow({ tin: '301234567' }))
        .mockResolvedValueOnce(detailRow());

      await service.update('d1', { tin: '  ' }, CTX);

      expect(prisma.catalogSeller.update).toHaveBeenCalledWith({
        where: { id: 'd1' },
        data: { tin: null },
      });
    });

    it('stores the tax data given at creation', async () => {
      // uniqueDealerId probes for a collision (none), then getOne re-reads.
      prisma.catalogSeller.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(detailRow());
      await service.create(
        { name: 'BYD Motors', tin: '209876543', vatPercent: 12 },
        CTX,
      );
      expect(prisma.catalogSeller.create.mock.calls[0][0].data).toMatchObject({
        tin: '209876543',
        vatPercent: 12,
      });
    });

    it('leaves a dealer onboarded WITHOUT tax data unconfigured, not defaulted', async () => {
      prisma.catalogSeller.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(detailRow());
      await service.create({ name: 'New Dealer' }, CTX);
      expect(prisma.catalogSeller.create.mock.calls[0][0].data).toMatchObject({
        tin: null,
        vatPercent: null,
      });
    });

    /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- the audit double is untyped, as elsewhere in this file */
    describe("Mator's commission rate (Phase 3)", () => {
      it('sets a rate for this dealer, audited before and after', async () => {
        prisma.catalogSeller.findUnique
          .mockResolvedValueOnce(mutableRow({ commissionPercent: null }))
          .mockResolvedValueOnce(detailRow());

        await service.update('d1', { commissionPercent: 7.5 }, CTX);

        expect(prisma.catalogSeller.update).toHaveBeenCalledWith({
          where: { id: 'd1' },
          data: { commissionPercent: 7.5 },
        });
        const [entry] = audit.record.mock.calls[0];
        expect(entry.previousValues).toEqual({ commissionPercent: null });
        expect(entry.newValues).toEqual({ commissionPercent: 7.5 });
      });

      it('an explicit 0 is a rate, written as such', async () => {
        prisma.catalogSeller.findUnique
          .mockResolvedValueOnce(mutableRow({ commissionPercent: null }))
          .mockResolvedValueOnce(detailRow());

        await service.update('d1', { commissionPercent: 0 }, CTX);

        expect(prisma.catalogSeller.update).toHaveBeenCalledWith({
          where: { id: 'd1' },
          data: { commissionPercent: 0 },
        });
      });

      it('null clears it back to not configured', async () => {
        prisma.catalogSeller.findUnique
          .mockResolvedValueOnce(
            mutableRow({ commissionPercent: { toString: () => '5' } }),
          )
          .mockResolvedValueOnce(detailRow());

        await service.update('d1', { commissionPercent: null }, CTX);

        expect(prisma.catalogSeller.update).toHaveBeenCalledWith({
          where: { id: 'd1' },
          data: { commissionPercent: null },
        });
      });

      it('the same rate again writes nothing', async () => {
        prisma.catalogSeller.findUnique
          .mockResolvedValueOnce(
            mutableRow({ commissionPercent: { toString: () => '5' } }),
          )
          .mockResolvedValueOnce(detailRow());

        await service.update('d1', { commissionPercent: 5 }, CTX);

        expect(prisma.catalogSeller.update).not.toHaveBeenCalled();
      });

      it('presents not configured apart from an explicit 0', async () => {
        prisma.catalogSeller.findUnique.mockResolvedValue(
          detailRow({ commissionPercent: null }),
        );
        expect((await service.getOne('d1')).data).toMatchObject({
          commissionPercent: null,
        });
        prisma.catalogSeller.findUnique.mockResolvedValue(
          detailRow({ commissionPercent: 0 }),
        );
        expect((await service.getOne('d1')).data).toMatchObject({
          commissionPercent: 0,
        });
      });

      it('refuses a rate that is no percentage', () => {
        const errors = (commissionPercent: unknown) =>
          validateSync(
            plainToInstance(UpdateAdminDealerDto, { commissionPercent }),
          );
        expect(errors(-1).length).toBeGreaterThan(0);
        expect(errors(101).length).toBeGreaterThan(0);
        expect(errors(2.555).length).toBeGreaterThan(0);
        expect(errors(null)).toHaveLength(0);
        expect(errors(12.5)).toHaveLength(0);
      });
    });
    /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */

    it('presents both fields, and the derived readiness flag', async () => {
      prisma.catalogSeller.findUnique.mockResolvedValue(
        detailRow({ tin: '301234567', vatPercent: 0 }),
      );
      const { data } = await service.getOne('d1');
      // A 0% dealer IS configured — the flag reads null-ness, not truthiness.
      expect(data).toMatchObject({
        tin: '301234567',
        vatPercent: 0,
        fiscalConfigured: true,
      });

      prisma.catalogSeller.findUnique.mockResolvedValue(detailRow());
      expect((await service.getOne('d1')).data).toMatchObject({
        tin: null,
        vatPercent: null,
        fiscalConfigured: false,
      });
    });
  });
});

// The DTOs are the trust boundary: bad input must be rejected by the global
// ValidationPipe (400) rather than reaching Prisma.
describe('ListAdminDealersQueryDto', () => {
  function validate(payload: Record<string, unknown>) {
    return validateSync(
      plainToInstance(ListAdminDealersQueryDto, payload, {
        enableImplicitConversion: false,
      }),
    );
  }

  it('accepts the documented query', () => {
    expect(
      validate({
        page: 1,
        limit: 100,
        status: 'active',
        search: 'auto',
        sort: 'gmvUzs',
        order: 'desc',
      }),
    ).toHaveLength(0);
  });

  it('rejects an unknown sort field', () => {
    const errors = validate({ sort: 'gmv; DROP TABLE' });
    expect(errors).not.toHaveLength(0);
    expect(errors[0].property).toBe('sort');
  });

  it('rejects an unknown status', () => {
    const errors = validate({ status: 'deleted' });
    expect(errors[0].property).toBe('status');
  });

  it('rejects an unknown sort direction', () => {
    const errors = validate({ order: 'sideways' });
    expect(errors[0].property).toBe('order');
  });

  it('rejects a limit above the documented maximum', () => {
    expect(validate({ limit: 500 })).not.toHaveLength(0);
  });
});

describe('UpdateAdminDealerDto', () => {
  function validate(payload: Record<string, unknown>) {
    return validateSync(plainToInstance(UpdateAdminDealerDto, payload));
  }

  it('accepts the editable fields', () => {
    expect(validate({ certified: true, lowestPrice: false })).toHaveLength(0);
    expect(validate({ status: 'active' })).toHaveLength(0);
  });

  it('rejects a non-boolean badge', () => {
    const errors = validate({ certified: 'yes' });
    expect(errors[0].property).toBe('certified');
  });

  it('rejects an invalid status enum value', () => {
    const errors = validate({ status: 'ACTIVE' });
    expect(errors[0].property).toBe('status');
  });

  it('rejects an over-long suspension reason', () => {
    expect(validate({ reason: 'x'.repeat(501) })).not.toHaveLength(0);
  });

  // ── Налоговые данные ────────────────────────────────────────────────────
  it('accepts a 9-digit ИНН and a 14-digit ПИНФЛ', () => {
    expect(validate({ tin: '301234567' })).toHaveLength(0);
    expect(validate({ tin: '12345678901234' })).toHaveLength(0);
  });

  it('rejects a TIN of any other length or shape', () => {
    expect(validate({ tin: '30123456' })[0].property).toBe('tin');
    expect(validate({ tin: '3012345678' })[0].property).toBe('tin');
    expect(validate({ tin: '30123456X' })[0].property).toBe('tin');
  });

  it('accepts an empty TIN as "clear this field"', () => {
    expect(validate({ tin: '' })).toHaveLength(0);
  });

  it('accepts exactly the two VAT rates: 12 and an explicit 0', () => {
    expect(validate({ vatPercent: 0 })).toHaveLength(0);
    expect(validate({ vatPercent: 12 })).toHaveLength(0);
    // A form posting the rate as text is read as the number it states.
    expect(validate({ vatPercent: '12' })).toHaveLength(0);
  });

  it.each([4, 15, 12.5, 7, 100, -1, 101, 'twelve'])(
    'rejects any other VAT rate: %j',
    (vatPercent) => {
      const errors = validate({ vatPercent });
      expect(errors[0].property).toBe('vatPercent');
      expect(Object.values(errors[0].constraints ?? {})).toEqual([
        'vatPercent must be one of 0, 12',
      ]);
    },
  );

  // Derived metrics (gmvUzs, orders, skus, joinedAt) stay absent from the class,
  // so the global pipe's forbidNonWhitelisted rejects them; the editable set is
  // the badges, the status, and the storefront presentation fields.
  it('declares only the editable fields', () => {
    const instance = plainToInstance(UpdateAdminDealerDto, {
      name: 'BYD Motors',
      city: 'Toshkent, UZ',
      email: 'hi@byd.uz',
      phone: '+998901234567',
      brandColor: '#2A6FDB',
      initial: 'B',
      logoUrl: 'https://res.cloudinary.com/mator/image/upload/x.png',
      orders: '18k+',
      years: 12,
      certified: true,
      lowestPrice: false,
      status: 'active',
      reason: 'x',
      tin: '301234567',
      vatPercent: 12,
      commissionPercent: 5,
      pickupLat: 41.31,
      pickupLng: 69.28,
    });
    expect(Object.keys(instance).sort()).toEqual([
      'brandColor',
      'certified',
      'city',
      'commissionPercent',
      'email',
      'initial',
      'logoUrl',
      'lowestPrice',
      'name',
      'orders',
      'phone',
      'pickupLat',
      'pickupLng',
      'reason',
      'status',
      'tin',
      'vatPercent',
      'years',
    ]);
  });
});

describe('CreateAdminDealerDto VAT rate', () => {
  const validate = (payload: Record<string, unknown>) =>
    validateSync(
      plainToInstance(CreateAdminDealerDto, { name: 'BYD Motors', ...payload }),
    );

  it('takes 12, 0, or no rate at all (configured later)', () => {
    expect(validate({ vatPercent: 12 })).toHaveLength(0);
    expect(validate({ vatPercent: 0 })).toHaveLength(0);
    expect(validate({})).toHaveLength(0);
  });

  it.each([4, 15, 12.5, 100])('refuses %j', (vatPercent) => {
    expect(validate({ vatPercent })[0].property).toBe('vatPercent');
  });
});

describe('UpdateAdminDealerDto pickup coordinates', () => {
  const errorsFor = (body: unknown) =>
    validateSync(plainToInstance(UpdateAdminDealerDto, body) as object);

  it('accepts a real location', () => {
    expect(errorsFor({ pickupLat: 41.31, pickupLng: 69.28 })).toHaveLength(0);
  });

  it.each([
    [{ pickupLat: 90.1 }],
    [{ pickupLat: -90.1 }],
    [{ pickupLng: 180.1 }],
    [{ pickupLng: -180.1 }],
    [{ pickupLat: 'north' }],
  ])('refuses %j', (body) => {
    expect(errorsFor(body)).not.toHaveLength(0);
  });
});

describe('SuspendAdminDealerDto', () => {
  it('accepts an absent reason', () => {
    expect(validateSync(plainToInstance(SuspendAdminDealerDto, {}))).toHaveLength(
      0,
    );
  });

  it('rejects an over-long reason', () => {
    expect(
      validateSync(
        plainToInstance(SuspendAdminDealerDto, { reason: 'x'.repeat(501) }),
      ),
    ).not.toHaveLength(0);
  });
});
