import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { buyerListed } from '../../catalog/buyer-visibility';
import { clampLimit } from '../../common/pagination.util';
import { PrismaService } from '../../prisma/prisma.service';
import { FavoriteListDto } from './favorites.dto';

@Injectable()
export class FavoritesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, dto: FavoriteListDto) {
    const limit = clampLimit(dto.limit, 50, 100);
    const cursor = this.readCursor(dto.pageToken, userId);
    const rows = await this.prisma.userFavorite.findMany({
      where: {
        userId,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: new Date(cursor.createdAt) } },
                {
                  createdAt: new Date(cursor.createdAt),
                  partId: { gt: cursor.partId },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { partId: 'asc' }],
      take: limit + 1,
      select: { partId: true, createdAt: true },
    });
    const items = rows.slice(0, limit);
    return {
      items,
      nextPageToken:
        rows.length > limit
          ? Buffer.from(
              JSON.stringify({
                v: 1,
                partId: items[items.length - 1].partId,
                createdAt: items[items.length - 1].createdAt.toISOString(),
                owner: this.ownerKey(userId),
              }),
            ).toString('base64url')
          : null,
    };
  }

  async add(userId: string, partId: string) {
    return this.withOwner(userId, async (tx) => {
      await this.lockParts(tx, [partId]);
      if (
        !(await tx.catalogPart.findFirst({
          where: buyerListed({ id: partId }),
          select: { id: true },
        }))
      ) {
        throw new NotFoundException('Catalog part not found');
      }
      return tx.userFavorite.upsert({
        where: { userId_partId: { userId, partId } },
        create: { userId, partId },
        update: {},
        select: { partId: true, createdAt: true },
      });
    });
  }

  async remove(userId: string, partId: string): Promise<void> {
    await this.withOwner(userId, async (tx) => {
      await tx.userFavorite.deleteMany({ where: { userId, partId } });
    });
  }

  async import(userId: string, partIds: string[], importId: string) {
    const unique = [...new Set(partIds)].sort();
    const payloadHash = createHash('sha256')
      .update(JSON.stringify(unique))
      .digest('hex');
    return this.withOwner(userId, async (tx) => {
      const receipt = await tx.favoriteImport.findUnique({
        where: { userId_importId: { userId, importId } },
      });
      if (receipt) {
        if (receipt.payloadHash !== payloadHash)
          throw new ConflictException(
            'Import ID already used for different parts',
          );
        return {
          acceptedIds: receipt.acceptedIds,
          missingIds: receipt.missingIds,
        };
      }
      await this.lockParts(tx, unique);
      const found = await tx.catalogPart.findMany({
        where: buyerListed({ id: { in: unique } }),
        select: { id: true },
      });
      const existing = new Set(found.map((p) => p.id));
      const acceptedIds = unique.filter((id) => existing.has(id));
      if (acceptedIds.length) {
        await tx.userFavorite.createMany({
          data: acceptedIds.map((partId) => ({ userId, partId })),
          skipDuplicates: true,
        });
      }
      const missingIds = unique.filter((id) => !existing.has(id));
      await tx.favoriteImport.create({
        data: { userId, importId, payloadHash, acceptedIds, missingIds },
      });
      return { acceptedIds, missingIds };
    });
  }

  private async lockParts(
    tx: Prisma.TransactionClient,
    ids: string[],
  ): Promise<void> {
    if (ids.length)
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "catalog_parts" WHERE "id" IN (${Prisma.join([...ids].sort())}) ORDER BY "id" FOR KEY SHARE`,
      );
  }

  // Serialize favorites and account deletion using the same owner-row lock.
  // This prevents a request authorized before deletion recreating personal data.
  private withOwner<T>(
    userId: string,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT 1 FROM "app_users" WHERE "id" = ${userId}::uuid FOR UPDATE`,
      );
      const owner = await tx.appUser.findUnique({
        where: { id: userId },
        select: { deletedAt: true },
      });
      if (!owner || owner.deletedAt)
        throw new UnauthorizedException('Account unavailable');
      return operation(tx);
    });
  }

  private ownerKey(userId: string): string {
    return createHash('sha256').update(userId).digest('hex');
  }

  private readCursor(
    token: string | undefined,
    userId: string,
  ): { partId: string; createdAt: string } | undefined {
    if (token == null) return undefined;
    try {
      if (token.length > 512 || !/^[A-Za-z0-9_-]+$/.test(token))
        throw new Error();
      const value = JSON.parse(
        Buffer.from(token, 'base64url').toString('utf8'),
      ) as Record<string, unknown> | null;
      if (
        typeof value?.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(value.createdAt)) ||
        value?.v !== 1 ||
        value.owner !== this.ownerKey(userId) ||
        typeof value.partId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(value.partId)
      )
        throw new Error();
      return { partId: value.partId, createdAt: value.createdAt };
    } catch {
      throw new BadRequestException('Invalid favorites page token');
    }
  }
}
