import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AppLang,
  DEFAULT_APP_LANG,
  localizedCategoryName,
} from '../../common/app-lang.util';
import { ListCategoriesQueryDto } from './dto/list-categories.query.dto';
import {
  VEHICLE_FIT_SELECT,
  toVehicleFitContext,
  vehicleFitWhere,
} from '../compatibility/vehicle-fitment';
import { VEHICLE_CATEGORIES } from './part-categories.catalog';
import { buyerListed } from '../buyer-visibility';
import { loadCategoryTreeScope } from './category-tree-scope';

/**
 * Per-category part counts summed under the key each category resolves to;
 * a category that resolves to none (null) is on no tile.
 */
function tally<K>(
  grouped: { categoryId: string; _count: { _all: number } }[],
  keyOf: (categoryId: string) => K | null,
): Map<K, number> {
  const counts = new Map<K, number>();
  for (const g of grouped) {
    const key = keyOf(g.categoryId);
    if (key !== null) counts.set(key, (counts.get(key) ?? 0) + g._count._all);
  }
  return counts;
}

/**
 * Serves the two-level part category hierarchy with LIVE per-category inventory
 * counts, so the frontend can render the home-page grid (main) and the make/model
 * grouping (vehicle) without any client-side processing. When a garage vehicle is
 * supplied, counts are scoped to parts that fit that vehicle — through the SAME
 * decision path as GET /v1/catalog/parts?vehicle_id= (vehicleFitWhere), so a
 * count can never include a part the listing then refuses to show.
 */
@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The category grid. `lang` picks each row's display `label`; ids, slugs,
   * counts and ordering are identical in every language.
   */
  async list(
    query: ListCategoriesQueryDto,
    lang: AppLang = DEFAULT_APP_LANG,
    userId: string | null = null,
  ) {
    const scope = query.scope ?? 'main';
    // Counts cover exactly what the listing can show: buyer-listed parts (no
    // suspended dealer, a ready photo), scoped to the garage vehicle when one
    // is given.
    const [scopeWhere, tree] = await Promise.all([
      this.vehicleScopeWhere(query.vehicle_id, userId),
      loadCategoryTreeScope(this.prisma),
    ]);
    const vehicleWhere = buyerListed(scopeWhere);

    // Both scopes count parts per `category_id` and attribute each category to
    // its bucket / system through the live tree — the same derivation
    // GET /v1/catalog/parts filters by — never through the stored
    // main_category / vehicle_category copies (see category-tree-scope.ts).
    const grouped = await this.prisma.catalogPart.groupBy({
      by: ['categoryId'],
      where: vehicleWhere,
      _count: { _all: true },
    });

    if (scope === 'vehicle') {
      const counts = tally(grouped, (id) => tree.vehicleCategoryOf(id));
      return {
        items: VEHICLE_CATEGORIES.map((c) => ({
          id: c.id,
          name: c.name,
          // The vehicle scope is served from the hardcoded VEHICLE_CATEGORIES
          // table, which carries ONE name — so `label` mirrors it rather than
          // pretending to be localized. It is present so a client can read
          // `label` uniformly across both scopes instead of branching.
          label: c.name,
          slug: c.slug,
          count: counts.get(c.id) ?? 0,
          iconKey: c.iconKey,
          color: c.color,
        })),
        total: VEHICLE_CATEGORIES.length,
      };
    }

    // Main scope is served from PartCategory — the single editable source of
    // truth (the 12 canonical rows, isActive + mainCategory NOT NULL), NOT the
    // hardcoded MAIN_CATEGORIES. Counts are LIVE: parts group by their
    // category_id, each category rolls up to its bucket through the tree, and
    // when a garage vehicle is supplied we scope to fitting parts. The wire shape
    // (id, name, slug, count, iconKey, color) is unchanged; `id` is the slug.
    const categories = await this.prisma.partCategory.findMany({
      where: { isActive: true, mainCategory: { not: null } },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true,
        name: true,
        nameRu: true,
        nameUz: true,
        nameEn: true,
        slug: true,
        iconKey: true,
        color: true,
        mainCategory: true,
      },
    });

    // A part filed on a SUBCATEGORY (e.g. 'oil-filters') rolls up to the
    // Filters bucket through the tree, exactly as ?category=filters lists it.
    const counts = tally(grouped, (id) => tree.mainCategoryOf(id));

    return {
      items: categories.map((c) => ({
        id: c.id,
        // `name` stays for backwards compatibility; a localized client renders
        // the name matching its active locale from the three fields below.
        name: c.name,
        // The display name for THIS request's language — what the grid shows.
        label: localizedCategoryName(c, lang),
        name_ru: c.nameRu,
        name_uz: c.nameUz,
        name_en: c.nameEn,
        slug: c.slug ?? c.id,
        count: c.mainCategory ? (counts.get(c.mainCategory) ?? 0) : 0,
        iconKey: c.iconKey,
        color: c.color,
      })),
      total: categories.length,
    };
  }

  /**
   * Build the where-clause that scopes counts to a garage vehicle (the shared
   * vehicleFitWhere). Returns undefined (no scoping) when no/unknown vehicle is
   * given — and a vehicle outside `userId`'s own garage (or any vehicle for an
   * anonymous caller) counts as unknown, exactly like the parts listing.
   */
  private async vehicleScopeWhere(
    vehicleId?: string,
    userId?: string | null,
  ): Promise<Prisma.CatalogPartWhereInput | undefined> {
    if (!vehicleId || !userId) return undefined;
    const v = await this.prisma.vehicle.findFirst({
      where: { id: vehicleId, userId, deletedAt: null },
      select: VEHICLE_FIT_SELECT,
    });
    if (!v) return undefined;
    return vehicleFitWhere(toVehicleFitContext(v));
  }
}
