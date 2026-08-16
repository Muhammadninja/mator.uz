import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ListCategoriesQueryDto } from './dto/list-categories.query.dto';
import { VEHICLE_CATEGORIES } from './part-categories.catalog';

/**
 * Serves the two-level part category hierarchy with LIVE per-category inventory
 * counts, so the frontend can render the home-page grid (main) and the make/model
 * grouping (vehicle) without any client-side processing. When a garage vehicle is
 * supplied, counts are scoped to parts that fit that vehicle (universal parts plus
 * parts whose make/model fit rows match).
 */
@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListCategoriesQueryDto) {
    const scope = query.scope ?? 'main';
    const vehicleWhere = await this.vehicleScopeWhere(query.vehicle_id);

    if (scope === 'vehicle') {
      const grouped = await this.prisma.catalogPart.groupBy({
        by: ['vehicleCategory'],
        where: vehicleWhere,
        _count: { _all: true },
      });
      const counts = new Map(grouped.map((g) => [g.vehicleCategory, g._count._all]));
      return {
        items: VEHICLE_CATEGORIES.map((c) => ({
          id: c.id,
          name: c.name,
          slug: c.slug,
          count: counts.get(c.id) ?? 0,
          iconKey: c.iconKey,
          color: c.color,
        })),
        total: VEHICLE_CATEGORIES.length,
      };
    }

    // Main scope is now served from PartCategory — the single editable source of
    // truth (the 12 canonical rows, isActive + mainCategory NOT NULL), NOT the
    // hardcoded MAIN_CATEGORIES. Counts are still LIVE: parts group by their
    // category_id FK (kept in sync with main_category by backfill + ingest), and
    // when a garage vehicle is supplied we scope to fitting parts. The wire shape
    // (id, name, slug, count, iconKey, color) is unchanged; `id` is now the slug.
    const categories = await this.prisma.partCategory.findMany({
      where: { isActive: true, mainCategory: { not: null } },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true,
        name: true,
        slug: true,
        iconKey: true,
        color: true,
        mainCategory: true,
      },
    });

    // Count by mainCategory, NOT by exact categoryId: a part filed on a
    // SUBCATEGORY (e.g. 'oil-filters') still carries mainCategory FILTERS, so it
    // rolls up to the Filters bucket here. Grouping by categoryId would drop
    // every sub-filed part from the home grid the moment reclassification runs.
    const grouped = await this.prisma.catalogPart.groupBy({
      by: ['mainCategory'],
      where: vehicleWhere,
      _count: { _all: true },
    });
    const counts = new Map(grouped.map((g) => [g.mainCategory, g._count._all]));

    return {
      items: categories.map((c) => ({
        id: c.id,
        name: c.name,
        slug: c.slug ?? c.id,
        count: c.mainCategory ? (counts.get(c.mainCategory) ?? 0) : 0,
        iconKey: c.iconKey,
        color: c.color,
      })),
      total: categories.length,
    };
  }

  /**
   * Build the where-clause that scopes counts to a garage vehicle: universal
   * parts plus parts whose make/model fit rows match the vehicle. Returns
   * undefined (no scoping) when no/unknown vehicle is given.
   */
  private async vehicleScopeWhere(
    vehicleId?: string,
  ): Promise<Prisma.CatalogPartWhereInput | undefined> {
    if (!vehicleId) return undefined;
    const v = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { make: { select: { name: true } }, model: { select: { name: true } } },
    });
    if (!v) return undefined;

    const fitConds: Prisma.CatalogPartFitWhereInput[] = [];
    if (v.model?.name) fitConds.push({ modelName: { equals: v.model.name, mode: 'insensitive' } });
    if (v.make?.name) fitConds.push({ makeName: { equals: v.make.name, mode: 'insensitive' } });

    const or: Prisma.CatalogPartWhereInput[] = [{ isUniversal: true }];
    if (fitConds.length > 0) or.push({ fits: { some: { OR: fitConds } } });
    return { OR: or };
  }
}
