import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, PartCondition } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ListPartsQueryDto } from './dto/list-parts.query.dto';
import {
  PART_INCLUDE,
  presentPartItem,
  computeCompatibility,
  VehicleCompatContext,
} from './part.presenter';

const DEFAULT_PAGE_SIZE = 20;

@Injectable()
export class PartsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListPartsQueryDto) {
    const where = this.buildWhere(query);
    const vehicle = await this.loadVehicle(query.vehicle_id);
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;

    const [total, items, brandFacet, priceAgg] = await Promise.all([
      this.prisma.catalogPart.count({ where }),
      this.prisma.catalogPart.findMany({
        where,
        include: PART_INCLUDE,
        orderBy: this.buildOrderBy(query.sort_by),
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.catalogPart.groupBy({ by: ['brandId'], where, _count: { _all: true } }),
      this.prisma.catalogPart.aggregate({ where, _min: { priceUzs: true }, _max: { priceUzs: true } }),
    ]);

    return {
      items: items.map((p) => presentPartItem(p, vehicle)),
      facets: {
        brands: await this.brandFacet(brandFacet),
        price_range_uzs: {
          min: Number(priceAgg._min.priceUzs ?? 0),
          max: Number(priceAgg._max.priceUzs ?? 0),
        },
        compatibility: vehicle ? await this.compatibilityFacet(where, vehicle) : null,
      },
      page,
      page_size: pageSize,
      total,
      next_page: page * pageSize < total ? page + 1 : null,
    };
  }

  async detail(partId: string, vehicleId?: string) {
    const part = await this.prisma.catalogPart.findUnique({
      where: { id: partId },
      include: PART_INCLUDE,
    });
    if (!part) throw new NotFoundException('Part not found');
    const vehicle = await this.loadVehicle(vehicleId);
    return presentPartItem(part, vehicle);
  }

  async compatibility(partId: string, vehicleId: string) {
    const part = await this.prisma.catalogPart.findUnique({
      where: { id: partId },
      include: { compatibilities: true },
    });
    if (!part) throw new NotFoundException('Part not found');

    const vehicle = await this.loadVehicle(vehicleId);
    const result = computeCompatibility(part.compatibilities, vehicle);

    return {
      part_id: partId,
      vehicle_id: vehicleId,
      status: result?.status ?? 'maybe',
      confidence: result?.confidence ?? 0,
      matched_trims: part.compatibilities
        .filter((c) => c.trimId)
        .map((c) => ({ trim_id: c.trimId, years: c.years })),
      matched_engines: [
        ...new Set(part.compatibilities.filter((c) => c.engineId).map((c) => c.engineId as string)),
      ],
      source: part.compatibilities[0]?.source ?? null,
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  private buildWhere(q: ListPartsQueryDto): Prisma.CatalogPartWhereInput {
    const where: Prisma.CatalogPartWhereInput = {};
    if (q.category_id) where.categoryId = q.category_id;
    if (q.brand_ids) {
      where.brandId = { in: q.brand_ids.split(',').map((s) => s.trim()).filter(Boolean) };
    }
    if (q.condition) where.condition = q.condition.toUpperCase() as PartCondition;
    if (q.in_stock_only === 'true') where.inStock = true;
    if (q.search) where.title = { contains: q.search, mode: 'insensitive' };
    if (q.min_price_uzs != null || q.max_price_uzs != null) {
      where.priceUzs = {
        ...(q.min_price_uzs != null ? { gte: q.min_price_uzs } : {}),
        ...(q.max_price_uzs != null ? { lte: q.max_price_uzs } : {}),
      };
    }
    return where;
  }

  private buildOrderBy(sortBy?: string): Prisma.CatalogPartOrderByWithRelationInput {
    if (sortBy === 'price_asc') return { priceUzs: 'asc' };
    if (sortBy === 'price_desc') return { priceUzs: 'desc' };
    return { createdAt: 'desc' };
  }

  private async loadVehicle(vehicleId?: string): Promise<VehicleCompatContext | null> {
    if (!vehicleId) return null;
    const v = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { trimId: true, engineId: true, year: true },
    });
    return v ? { trimId: v.trimId, engineId: v.engineId, year: v.year } : null;
  }

  private async brandFacet(grouped: { brandId: string | null; _count: { _all: number } }[]) {
    const ids = grouped.map((g) => g.brandId).filter((x): x is string => !!x);
    const brands = await this.prisma.partBrand.findMany({ where: { id: { in: ids } } });
    const names = new Map(brands.map((b) => [b.id, b.name]));
    return grouped
      .filter((g) => g.brandId)
      .map((g) => ({ id: g.brandId, name: names.get(g.brandId as string) ?? g.brandId, count: g._count._all }));
  }

  private async compatibilityFacet(where: Prisma.CatalogPartWhereInput, vehicle: VehicleCompatContext) {
    const all = await this.prisma.catalogPart.findMany({ where, select: { compatibilities: true } });
    let fits = 0;
    let maybe = 0;
    let doesNotFit = 0;
    for (const p of all) {
      const c = computeCompatibility(p.compatibilities, vehicle);
      if (c?.status === 'fits') fits++;
      else if (c?.status === 'does_not_fit') doesNotFit++;
      else maybe++;
    }
    return { fits, maybe, does_not_fit: doesNotFit };
  }
}
