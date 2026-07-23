// Integration tests for the user Address CRUD service (Phase 4A). Prisma is
// mocked — no DB. These guard: ownership scoping (only own addresses), the
// single-default invariant (transactional promote/demote), first-address auto
// default, delete-promotes-newest, and 404 on unknown/foreign ids.

import { NotFoundException } from '@nestjs/common';
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

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new AddressesService(prisma as never);
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
