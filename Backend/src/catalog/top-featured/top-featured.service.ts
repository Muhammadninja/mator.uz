import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { formatUzs } from '../parts/part.presenter';
import { TopFeaturedDto } from './dto/top-featured.dto';

const DEFAULT_PAGE_SIZE = 24;

@Injectable()
export class TopFeaturedService {
  constructor(private readonly prisma: PrismaService) {}

  async list(dto: TopFeaturedDto) {
    const page = dto.page ?? 1;
    const pageSize = dto.pageSize ?? DEFAULT_PAGE_SIZE;
    const f = dto.filters ?? {};

    const where: Prisma.FeaturedItemWhereInput = { isActive: true };
    if (f.brand) where.brand = f.brand;
    if (f.model) where.model = f.model;
    if (f.color) where.color = f.color;
    if (f.condition) where.condition = f.condition;
    if (dto.search) where.title = { contains: dto.search, mode: 'insensitive' };

    const orderBy: Prisma.FeaturedItemOrderByWithRelationInput =
      dto.sortBy === 'featured' || !dto.sortBy ? { sortOrder: 'asc' } : { createdAt: 'desc' };

    const [total, items, brandGroup] = await Promise.all([
      this.prisma.featuredItem.count({ where }),
      this.prisma.featuredItem.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.featuredItem.groupBy({ by: ['brand'], where, _count: { _all: true } }),
    ]);

    return {
      items: items.map((i) => ({
        id: i.id,
        badge: i.badge,
        status: i.status,
        title: i.title,
        description: i.description,
        price: i.priceUzs != null ? formatUzs(i.priceUzs) : null,
        model: i.model,
        brand: i.brand,
        color: i.color,
        condition: i.condition,
        oem: i.oem,
      })),
      total,
      page,
      pageSize,
      availableFilters: [
        {
          key: 'brand',
          title: 'Brand',
          options: brandGroup
            .filter((g) => g.brand)
            .map((g) => ({ value: g.brand, label: g.brand, count: g._count._all })),
        },
      ],
      snapshotVersion: `tf-${new Date().toISOString().slice(0, 10)}-v1`,
      socketChannel: 'top_featured:catalog',
    };
  }
}
