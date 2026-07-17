import { Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  PartCondition,
  PartMainCategory,
  PartVehicleCategory,
  PartOriginRegion,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { clampLimit } from '../../common/pagination.util';
import { ListPartsQueryDto } from './dto/list-parts.query.dto';
import {
  PART_INCLUDE,
  presentPartItem,
  computeCompatibility,
  VehicleCompatContext,
} from './part.presenter';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// Wire market names → PartOriginRegion enum.
const REGION_BY_WIRE: Record<string, PartOriginRegion> = {
  china: PartOriginRegion.CHINA,
  europe: PartOriginRegion.EUROPE,
  russia: PartOriginRegion.RUSSIA,
  korea: PartOriginRegion.KOREA,
  usa: PartOriginRegion.USA,
  japan: PartOriginRegion.JAPAN,
};

const MAIN_CATEGORY_VALUES = new Set(Object.values(PartMainCategory));
const VEHICLE_CATEGORY_VALUES = new Set(Object.values(PartVehicleCategory));

/** Garage-vehicle context for compatibility: trim/engine (fine) + make/model names. */
interface VehicleFilterContext extends VehicleCompatContext {
  makeName: string | null;
  modelName: string | null;
}

@Injectable()
export class PartsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListPartsQueryDto) {
    const vehicle = await this.loadVehicle(query.vehicle_id);
    const where = this.buildWhere(query, vehicle);
    const page = query.page ?? 1;
    const pageSize = clampLimit(query.page_size, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const [total, items, brandFacet, priceAgg] = await Promise.all([
      this.prisma.catalogPart.count({ where }),
      this.prisma.catalogPart.findMany({
        where,
        include: PART_INCLUDE,
        orderBy: this.buildOrderBy(query.sort),
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
  private buildWhere(
    q: ListPartsQueryDto,
    vehicle: VehicleFilterContext | null,
  ): Prisma.CatalogPartWhereInput {
    const and: Prisma.CatalogPartWhereInput[] = [];

    // Category: prefer the classified main-category enum (BRAKES, …). A vehicle-
    // specific category enum (BRAKE_SYSTEM, …) is also accepted. Anything else is
    // treated as a legacy PartCategory id/slug on the FK for back-compat.
    if (q.category) {
      const up = q.category.toUpperCase();
      if (MAIN_CATEGORY_VALUES.has(up as PartMainCategory)) {
        and.push({ mainCategory: up as PartMainCategory });
      } else if (VEHICLE_CATEGORY_VALUES.has(up as PartVehicleCategory)) {
        and.push({ vehicleCategory: up as PartVehicleCategory });
      } else {
        and.push({ categoryId: q.category });
      }
    }
    if (q.vehicle_category) {
      const up = q.vehicle_category.toUpperCase();
      if (VEHICLE_CATEGORY_VALUES.has(up as PartVehicleCategory)) {
        and.push({ vehicleCategory: up as PartVehicleCategory });
      }
    }

    // Make / model filters — independent of the garage filter. Match on the
    // denormalized fit rows by slug OR canonical name (case-insensitive), so both
    // "make_chevrolet" and "Chevrolet" work. Universal parts (no fit rows) are
    // included since they fit every make/model.
    if (q.make) and.push(this.makeWhere(q.make));
    if (q.model) and.push(this.modelWhere(q.model));

    // Garage vehicle: only compatible parts. A part fits when it is universal, OR
    // its make/model fit rows match the vehicle, OR its trim/engine compatibility
    // rows are not an explicit miss. We approximate at the make/model level here
    // (indexed); the per-item compatibility annotation still uses trim/engine.
    if (vehicle) and.push(this.vehicleWhere(vehicle));

    if (q.brand) {
      and.push({ brandId: { in: q.brand.split(',').map((s) => s.trim()).filter(Boolean) } });
    }
    if (q.region && q.region.length > 0) {
      const regions = q.region.map((r) => REGION_BY_WIRE[r]).filter(Boolean);
      if (regions.length > 0) and.push({ originRegion: { in: regions } });
    }
    if (q.gm_only === 'true') and.push({ isGm: true });
    if (q.oem_only === 'true') and.push({ isOem: true });
    if (q.in_stock_only === 'true') and.push({ inStock: true });
    if (q.q) and.push({ title: { contains: q.q, mode: 'insensitive' } });

    return and.length > 0 ? { AND: and } : {};
  }

  /** Match universal parts OR parts whose fit rows reference the make. */
  private makeWhere(make: string): Prisma.CatalogPartWhereInput {
    const value = make.trim();
    return {
      OR: [
        { isUniversal: true },
        { fits: { some: { OR: [{ makeSlug: value }, { makeName: { equals: value, mode: 'insensitive' } }] } } },
      ],
    };
  }

  /** Match universal parts OR parts whose fit rows reference the model. */
  private modelWhere(model: string): Prisma.CatalogPartWhereInput {
    const value = model.trim();
    return {
      OR: [
        { isUniversal: true },
        { fits: { some: { OR: [{ modelSlug: value }, { modelName: { equals: value, mode: 'insensitive' } }] } } },
      ],
    };
  }

  /**
   * Garage-vehicle compatibility filter. A part is returned when:
   *   • it is universal, OR
   *   • its make/model fit rows match the vehicle's make/model, OR
   *   • it has a trim/engine compatibility row for the vehicle that is not an
   *     explicit DOES_NOT_FIT.
   * Parts with no fitment data at all are excluded (they can't be confirmed to
   * fit the selected vehicle).
   */
  private vehicleWhere(vehicle: VehicleFilterContext): Prisma.CatalogPartWhereInput {
    const or: Prisma.CatalogPartWhereInput[] = [{ isUniversal: true }];

    if (vehicle.makeName || vehicle.modelName) {
      const fitConds: Prisma.CatalogPartFitWhereInput[] = [];
      if (vehicle.modelName) fitConds.push({ modelName: { equals: vehicle.modelName, mode: 'insensitive' } });
      if (vehicle.makeName) fitConds.push({ makeName: { equals: vehicle.makeName, mode: 'insensitive' } });
      or.push({ fits: { some: { AND: [{ OR: fitConds }] } } });
    }

    if (vehicle.trimId || vehicle.engineId) {
      const compatOr: Prisma.PartCompatibilityWhereInput[] = [];
      if (vehicle.trimId) compatOr.push({ trimId: vehicle.trimId });
      if (vehicle.engineId) compatOr.push({ engineId: vehicle.engineId });
      or.push({
        compatibilities: {
          some: { AND: [{ OR: compatOr }, { NOT: { status: 'DOES_NOT_FIT' } }] },
        },
      });
    }

    return { OR: or };
  }

  private buildOrderBy(sort?: string): Prisma.CatalogPartOrderByWithRelationInput {
    if (sort === 'price_asc') return { priceUzs: 'asc' };
    if (sort === 'price_desc') return { priceUzs: 'desc' };
    return { createdAt: 'desc' };
  }

  private async loadVehicle(vehicleId?: string): Promise<VehicleFilterContext | null> {
    if (!vehicleId) return null;
    const v = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: {
        trimId: true,
        engineId: true,
        year: true,
        make: { select: { name: true } },
        model: { select: { name: true } },
      },
    });
    return v
      ? {
          trimId: v.trimId,
          engineId: v.engineId,
          year: v.year,
          makeName: v.make?.name ?? null,
          modelName: v.model?.name ?? null,
        }
      : null;
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
