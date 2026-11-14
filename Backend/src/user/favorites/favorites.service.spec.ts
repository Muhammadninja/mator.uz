import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { createPrismaMock } from '../../../test/utils/harness';
import { FavoritesService } from './favorites.service';

describe('FavoritesService', () => {
  const owner = '11111111-1111-4111-8111-111111111111';
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: FavoritesService;
  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.appUser.findUnique.mockResolvedValue({ deletedAt: null });
    service = new FavoritesService(prisma);
  });
  it('adds idempotently using only the authenticated owner', async () => {
    prisma.catalogPart.findFirst.mockResolvedValue({ id: 'part' });
    await service.add(owner, 'part');
    expect(prisma.userFavorite.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_partId: { userId: owner, partId: 'part' } },
        create: { userId: owner, partId: 'part' },
        update: {},
      }),
    );
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });
  it('removes only this owner and tolerates missing rows', async () => {
    await service.remove(owner, 'part');
    expect(prisma.userFavorite.deleteMany).toHaveBeenCalledWith({
      where: { userId: owner, partId: 'part' },
    });
  });
  it('rejects writes after account deletion', async () => {
    prisma.appUser.findUnique.mockResolvedValue({ deletedAt: new Date() });
    await expect(service.add(owner, 'part')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.userFavorite.upsert).not.toHaveBeenCalled();
  });
  it('paginates with an owner-bound keyset independent of deleted cursor rows', async () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    prisma.userFavorite.findMany.mockResolvedValue([
      { partId: 'a', createdAt },
      { partId: 'b', createdAt },
    ]);
    const first = await service.list(owner, { limit: 1 });
    expect(first.items).toHaveLength(1);
    await service.list(owner, { limit: 1, pageToken: first.nextPageToken! });
    expect(prisma.userFavorite.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          userId: owner,
          OR: [
            { createdAt: { lt: createdAt } },
            { createdAt, partId: { gt: 'a' } },
          ],
        },
      }),
    );
    await expect(
      service.list('other-owner', { pageToken: first.nextPageToken! }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.list(owner, { pageToken: 'invalid' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it('imports additively, deduplicates and records missing IDs', async () => {
    prisma.catalogPart.findMany.mockResolvedValue([{ id: 'a' }]);
    expect(await service.import(owner, ['missing', 'a', 'a'], 'batch')).toEqual(
      { acceptedIds: ['a'], missingIds: ['missing'] },
    );
    expect(prisma.userFavorite.createMany).toHaveBeenCalledWith({
      data: [{ userId: owner, partId: 'a' }],
      skipDuplicates: true,
    });
    expect(prisma.favoriteImport.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: owner,
          importId: 'batch',
          acceptedIds: ['a'],
          missingIds: ['missing'],
        }),
      }),
    );
  });
  it('replays an import receipt without resurrecting later removed favorites', async () => {
    prisma.catalogPart.findMany.mockResolvedValue([{ id: 'a' }]);
    await service.import(owner, ['a'], 'batch');
    const receipt = prisma.favoriteImport.create.mock.calls[0][0].data;
    prisma.favoriteImport.findUnique.mockResolvedValue(receipt);
    prisma.userFavorite.createMany.mockClear();
    expect(await service.import(owner, ['a'], 'batch')).toEqual({
      acceptedIds: ['a'],
      missingIds: [],
    });
    expect(prisma.userFavorite.createMany).not.toHaveBeenCalled();
    await expect(service.import(owner, ['b'], 'batch')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
