/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- reads the arguments of a jest mock, which are untyped */
// Integration tests for the user Address CRUD service (Phase 4A). Prisma is
// mocked — no DB. These guard: ownership scoping (only own addresses), the
// single-default invariant (transactional promote/demote), first-address auto
// default, delete-promotes-newest, and 404 on unknown/foreign ids.

import { NotFoundException } from '@nestjs/common';
import { fakeConfig, TEST_DELIVERY_COVERAGE } from '../../test/utils/harness';
import { AddressesService } from './addresses.service';

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'addr_1',
    userId: 'user_1',
    label: null,
    regionCode: null,
    district: null,
    street: null,
    fullText: 'Somewhere 1',
    landmark: null,
    lat: null,
    lng: null,
    isDefault: false,
    createdAt: new Date('2026-07-16T10:00:00.000Z'),
    updatedAt: new Date('2026-07-16T10:00:00.000Z'),
    ...over,
  };
}

function makePrismaMock() {
  const address = {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    delete: jest.fn(),
  };
  // $transaction(cb) just runs the callback with the same mock (tx === prisma).
  const prisma: Record<string, unknown> = { address };
  prisma.$transaction = (cb: (tx: unknown) => unknown) => cb(prisma);
  return prisma as { address: typeof address; $transaction: (cb: (tx: unknown) => unknown) => unknown };
}

describe('AddressesService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: AddressesService;
  let stated: Record<string, number | null> = {};

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new AddressesService(
      prisma as never,
      fakeConfig({ DELIVERY_COVERAGE_POLYGON: TEST_DELIVERY_COVERAGE }),
    );
  });

  describe('create', () => {
    it('makes the FIRST address the default and demotes nothing else', async () => {
      prisma.address.count.mockResolvedValue(0);
      prisma.address.create.mockResolvedValue(row({ isDefault: true }));
      const res = await service.create('user_1', { full_text: 'Somewhere 1' });
      expect(prisma.address.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ userId: 'user_1', isDefault: true }) }),
      );
      expect(res.is_default).toBe(true);
    });

    it('demotes existing defaults when is_default: true on a non-first address', async () => {
      prisma.address.count.mockResolvedValue(2);
      prisma.address.create.mockResolvedValue(row({ id: 'addr_2', isDefault: true }));
      await service.create('user_1', { full_text: 'X', is_default: true });
      expect(prisma.address.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user_1', isDefault: true },
        data: { isDefault: false },
      });
    });

    it('does not become default when not first and is_default omitted', async () => {
      prisma.address.count.mockResolvedValue(1);
      prisma.address.create.mockResolvedValue(row({ id: 'addr_2', isDefault: false }));
      await service.create('user_1', { full_text: 'X' });
      expect(prisma.address.updateMany).not.toHaveBeenCalled();
      expect(prisma.address.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ isDefault: false }) }),
      );
    });
  });

  describe('update', () => {
    it('404s when the address belongs to another user', async () => {
      prisma.address.findUnique.mockResolvedValue(row({ userId: 'someone_else' }));
      await expect(service.update('user_1', 'addr_1', { label: 'x' })).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.address.update).not.toHaveBeenCalled();
    });

    it('404s when the address does not exist', async () => {
      prisma.address.findUnique.mockResolvedValue(null);
      await expect(service.update('user_1', 'nope', { label: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('promotes atomically and only updates provided fields', async () => {
      prisma.address.findUnique.mockResolvedValue(row());
      prisma.address.update.mockResolvedValue(row({ isDefault: true, label: 'Home' }));
      await service.update('user_1', 'addr_1', { is_default: true, label: 'Home' });
      expect(prisma.address.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user_1', isDefault: true, id: { not: 'addr_1' } },
        data: { isDefault: false },
      });
      // Only label + isDefault in the update payload (partial update).
      expect(prisma.address.update).toHaveBeenCalledWith({
        where: { id: 'addr_1' },
        data: { isDefault: true, label: 'Home' },
      });
    });
  });

  describe('a saved point on the map, which courier delivery is priced from', () => {
    const located = () =>
      row({
        fullText: 'Amir Temur 12, Toshkent',
        street: 'Amir Temur 12',
        district: 'Toshkent',
        lat: 41.31,
        lng: 69.28,
      });
    const written = () => prisma.address.update.mock.calls[0][0].data;

    beforeEach(() => {
      prisma.address.findUnique.mockResolvedValue(located());
      prisma.address.update.mockResolvedValue(located());
    });

    it.each([
      ['the full text', { full_text: 'Navoi 1, Toshkent' }],
      ['the street', { street: 'Navoi 1' }],
      ['the district', { district: 'Samarqand' }],
    ])('editing %s with no new point drops the old one', async (_, edit) => {
      await service.update('user_1', 'addr_1', edit);
      expect(written()).toMatchObject({ lat: null, lng: null });
    });

    it('editing the text together with a new point keeps the new point', async () => {
      await service.update('user_1', 'addr_1', {
        full_text: 'Navoi 1, Toshkent',
        lat: 41.33,
        lng: 69.3,
      });
      expect(written()).toMatchObject({ lat: 41.33, lng: 69.3 });
    });

    it.each([
      ['only the label', { label: 'Work' }],
      ['only the default flag', { is_default: true }],
      [
        'the same text again, as the app sends on every save',
        {
          full_text: 'Amir Temur 12, Toshkent',
          street: 'Amir Temur 12',
          district: 'Toshkent',
        },
      ],
    ])('editing %s keeps the point', async (_, edit) => {
      await service.update('user_1', 'addr_1', edit);
      expect(written()).not.toHaveProperty('lat');
      expect(written()).not.toHaveProperty('lng');
    });

    it('stating a point with no text change just sets it', async () => {
      prisma.address.findUnique.mockResolvedValue(
        row({ fullText: 'Navoi 1', lat: null, lng: null }),
      );
      await service.update('user_1', 'addr_1', { lat: 41.3, lng: 69.2 });
      expect(written()).toMatchObject({ lat: 41.3, lng: 69.2 });
    });

    it('the profile route follows the same rule', async () => {
      prisma.address.findFirst.mockResolvedValue(located());

      await service.upsertDefault('user_1', { full_text: 'Navoi 1, Toshkent' });

      expect(written()).toMatchObject({ lat: null, lng: null });
    });

    it('the profile route keeps a point when the text has not moved', async () => {
      prisma.address.findFirst.mockResolvedValue(located());

      await service.upsertDefault('user_1', {
        full_text: 'Amir Temur 12, Toshkent',
      });

      expect(written().lat).toBeUndefined();
      expect(written().lng).toBeUndefined();
    });
  });

  describe('a point the buyer chooses', () => {
    const accepted = ({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve(row(data));
    const refusal = async (promise: Promise<unknown>) =>
      (await promise.then(
        () => {
          throw new Error('expected a refusal');
        },
        (err: unknown) => err,
      )) as { getStatus: () => number; getResponse: () => { code: string } };

    beforeEach(() => {
      prisma.address.count.mockResolvedValue(0);
      prisma.address.create.mockImplementation(accepted);
      prisma.address.update.mockImplementation(accepted);
    });

    it('keeps the exact coordinates', async () => {
      const res = await service.create('user_1', {
        full_text: 'Work',
        lat: 41.311081234567,
        lng: 69.240562987654,
      });
      expect(res).toMatchObject({
        full_text: 'Work',
        lat: 41.311081234567,
        lng: 69.240562987654,
      });
    });

    it('needs no street address: the point describes itself for the courier', async () => {
      const res = await service.create('user_1', { lat: 41.3, lng: 69.2 });

      expect(res.full_text).toBe('41.3, 69.2');
      expect(res).toMatchObject({ lat: 41.3, lng: 69.2 });
    });

    it.each([undefined, '', '   '])(
      'refuses an address with neither words nor a point (%p)',
      async (full_text) => {
        const error = await refusal(service.create('user_1', { full_text }));
        expect(error.getStatus()).toBe(400);
        expect(error.getResponse().code).toBe('ADDRESS_TEXT_OR_POINT_REQUIRED');
        expect(prisma.address.create).not.toHaveBeenCalled();
      },
    );

    it('still takes words with no point, as installed builds send', async () => {
      const res = await service.create('user_1', { full_text: 'Navoi 1' });
      expect(res.full_text).toBe('Navoi 1');
      expect(res.lat ?? null).toBeNull();
    });

    describe.each([
      ['create', () => service.create('user_1', { full_text: 'X', ...stated })],
      ['update', () => service.update('user_1', 'addr_1', stated)],
      [
        'the profile route',
        () => service.upsertDefault('user_1', { full_text: 'X', ...stated }),
      ],
    ])('through %s', (_, write) => {
      beforeEach(() => {
        prisma.address.findUnique.mockResolvedValue(row());
        prisma.address.findFirst.mockResolvedValue(row());
      });

      it.each([
        ['half a pair', { lat: 41.3 }],
        ['the other half', { lng: 69.2 }],
        ['a half cleared', { lat: null, lng: 69.2 }],
        ['0,0', { lat: 0, lng: 0 }],
      ])('refuses %s', async (__, point) => {
        stated = point;
        const error = await refusal(write());
        expect(error.getStatus()).toBe(400);
        expect(error.getResponse().code).toBe(
          'DELIVERY_ADDRESS_COORDINATES_INVALID',
        );
        expect(prisma.address.create).not.toHaveBeenCalled();
        expect(prisma.address.update).not.toHaveBeenCalled();
      });

      it('refuses a point outside the delivery area', async () => {
        stated = { lat: 55.75, lng: 37.61 };
        const error = await refusal(write());
        expect(error.getStatus()).toBe(422);
        expect(error.getResponse().code).toBe('DELIVERY_OUTSIDE_COVERAGE');
        expect(prisma.address.create).not.toHaveBeenCalled();
        expect(prisma.address.update).not.toHaveBeenCalled();
      });

      it('takes any point inside it', async () => {
        stated = { lat: 39.65, lng: 66.96 };
        await expect(write()).resolves.toBeDefined();
      });
    });

    it('asks nothing about where the buyer is', async () => {
      // There is no way to state it: the only inputs are the point itself.
      const res = await service.create('user_1', {
        full_text: "Someone else's door",
        lat: 39.65,
        lng: 66.96,
      });
      expect(res).toMatchObject({ lat: 39.65, lng: 66.96 });
    });

    it('goes by the configured area', async () => {
      const narrow = new AddressesService(
        prisma as never,
        fakeConfig({
          DELIVERY_COVERAGE_POLYGON: JSON.stringify({
            type: 'Polygon',
            coordinates: [
              [
                [69, 41],
                [70, 41],
                [70, 42],
                [69, 42],
                [69, 41],
              ],
            ],
          }),
        }),
      );
      const error = await refusal(
        narrow.create('user_1', { lat: 39.65, lng: 66.96 }),
      );
      expect(error.getResponse().code).toBe('DELIVERY_OUTSIDE_COVERAGE');
    });

    describe('with no delivery area configured', () => {
      const open = () =>
        new AddressesService(prisma as never, fakeConfig());

      it('still saves a point: the buyer keeps their address, and no courier is quoted', async () => {
        await expect(
          open().create('user_1', { lat: 55.75, lng: 37.61 }),
        ).resolves.toMatchObject({ lat: 55.75, lng: 37.61 });
      });

      it('still refuses a point that is no place at all', async () => {
        const error = await refusal(
          open().create('user_1', { lat: 0, lng: 0 }),
        );
        expect(error.getResponse().code).toBe(
          'DELIVERY_ADDRESS_COORDINATES_INVALID',
        );
      });
    });

    describe('a hint for the courier', () => {
      it('is kept with the address', async () => {
        const res = await service.create('user_1', {
          lat: 41.3,
          lng: 69.2,
          landmark: ' Blue gate, second entrance ',
        });
        expect(res.landmark).toBe('Blue gate, second entrance');
      });

      it.each(['', '   ', null])('%p is no hint', async (landmark) => {
        prisma.address.findUnique.mockResolvedValue(
          row({ landmark: 'Old hint' }),
        );
        const res = await service.update('user_1', 'addr_1', {
          landmark,
        } as never);
        expect(res.landmark).toBeNull();
      });

      it('changing it leaves the point alone', async () => {
        prisma.address.findUnique.mockResolvedValue(
          row({ lat: 41.3, lng: 69.2 }),
        );
        await service.update('user_1', 'addr_1', { landmark: 'Blue gate' });
        const { data } = prisma.address.update.mock.calls[0][0];
        expect(data).toEqual({ landmark: 'Blue gate' });
      });

      it('is left alone by an edit that does not mention it', async () => {
        prisma.address.findUnique.mockResolvedValue(
          row({ landmark: 'Blue gate' }),
        );
        await service.update('user_1', 'addr_1', { label: 'Work' });
        expect(prisma.address.update.mock.calls[0][0].data).not.toHaveProperty(
          'landmark',
        );
      });
    });

    it('clearing both is allowed: the address just has no point any more', async () => {
      prisma.address.findUnique.mockResolvedValue(
        row({ lat: 41.3, lng: 69.2 }),
      );
      const res = await service.update('user_1', 'addr_1', {
        lat: null,
        lng: null,
      } as never);
      expect(res).toMatchObject({ lat: null, lng: null });
    });
  });

  describe('remove', () => {
    it('404s on a foreign address', async () => {
      prisma.address.findUnique.mockResolvedValue(row({ userId: 'other' }));
      await expect(service.remove('user_1', 'addr_1')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.address.delete).not.toHaveBeenCalled();
    });

    it('deletes and promotes the newest remaining when the default is removed', async () => {
      prisma.address.findUnique.mockResolvedValue(row({ isDefault: true }));
      prisma.address.findFirst.mockResolvedValue(row({ id: 'addr_2' }));
      const res = await service.remove('user_1', 'addr_1');
      expect(prisma.address.delete).toHaveBeenCalledWith({ where: { id: 'addr_1' } });
      expect(prisma.address.update).toHaveBeenCalledWith({ where: { id: 'addr_2' }, data: { isDefault: true } });
      expect(res).toEqual({ id: 'addr_1', deleted: true });
    });

    it('deletes without promotion when the removed address was not default', async () => {
      prisma.address.findUnique.mockResolvedValue(row({ isDefault: false }));
      await service.remove('user_1', 'addr_1');
      expect(prisma.address.findFirst).not.toHaveBeenCalled();
      expect(prisma.address.update).not.toHaveBeenCalled();
    });

    it('deleting the ONLY (default) address leaves none and promotes nothing', async () => {
      prisma.address.findUnique.mockResolvedValue(row({ isDefault: true }));
      // No addresses remain after the delete.
      prisma.address.findFirst.mockResolvedValue(null);
      const res = await service.remove('user_1', 'addr_1');
      expect(prisma.address.delete).toHaveBeenCalledWith({ where: { id: 'addr_1' } });
      // findFirst is consulted (it was the default) but there is nothing to promote.
      expect(prisma.address.findFirst).toHaveBeenCalled();
      expect(prisma.address.update).not.toHaveBeenCalled();
      expect(res).toEqual({ id: 'addr_1', deleted: true });
    });
  });

  describe('list', () => {
    it('orders default-first then newest and presents snake_case', async () => {
      prisma.address.findMany.mockResolvedValue([row({ isDefault: true })]);
      const res = await service.list('user_1');
      expect(prisma.address.findMany).toHaveBeenCalledWith({
        where: { userId: 'user_1' },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      });
      expect(res.items[0]).toEqual(
        expect.objectContaining({ id: 'addr_1', full_text: 'Somewhere 1', is_default: true }),
      );
    });
  });

  describe('getDefault', () => {
    it('returns the default address (snake_case) when one exists', async () => {
      prisma.address.findFirst.mockResolvedValue(row({ isDefault: true }));
      const res = await service.getDefault('user_1');
      expect(prisma.address.findFirst).toHaveBeenCalledWith({
        where: { userId: 'user_1', isDefault: true },
        orderBy: { createdAt: 'desc' },
      });
      expect(res).toEqual(expect.objectContaining({ id: 'addr_1', is_default: true }));
    });

    it('returns null when the user has no default address', async () => {
      prisma.address.findFirst.mockResolvedValue(null);
      expect(await service.getDefault('user_1')).toBeNull();
    });
  });

  describe('upsertDefault (PATCH /v1/me address)', () => {
    it('UPDATES the existing default in place — never creates a duplicate', async () => {
      prisma.address.findFirst.mockResolvedValue(row({ isDefault: true }));
      prisma.address.update.mockResolvedValue(row({ isDefault: true, fullText: 'New 5' }));

      const res = await service.upsertDefault('user_1', { full_text: 'New 5', label: 'Home' });

      expect(prisma.address.create).not.toHaveBeenCalled();
      expect(prisma.address.update).toHaveBeenCalledWith({
        where: { id: 'addr_1' },
        data: expect.objectContaining({ fullText: 'New 5', label: 'Home' }),
      });
      expect(res.full_text).toBe('New 5');
      expect(res.is_default).toBe(true);
    });

    it('CREATES a default (demoting strays) when the user has none', async () => {
      prisma.address.findFirst.mockResolvedValue(null);
      prisma.address.create.mockResolvedValue(row({ isDefault: true, fullText: 'First' }));

      const res = await service.upsertDefault('user_1', { full_text: 'First' });

      expect(prisma.address.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user_1', isDefault: true },
        data: { isDefault: false },
      });
      expect(prisma.address.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ userId: 'user_1', isDefault: true, fullText: 'First' }) }),
      );
      expect(res.is_default).toBe(true);
    });
  });
});
