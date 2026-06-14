import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { formatUzs } from '../parts/part.presenter';
import { SearchDto } from './dto/search.dto';

@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  /** Universal parts search with facet counts (POST /v1/search). */
  async search(dto: SearchDto) {
    const startedAt = Date.now();
    const q = dto.query?.trim() ?? '';
    const limit = dto.limit ?? 20;
    const categories = (dto.filters?.categories as string[] | undefined) ?? [];

    const where: Prisma.CatalogPartWhereInput = {};
    if (q) where.title = { contains: q, mode: 'insensitive' };
    if (categories.length) where.categoryId = { in: categories };

    const [total, items, catGroup, under200k, between, highRated] = await Promise.all([
      this.prisma.catalogPart.count({ where }),
      this.prisma.catalogPart.findMany({
        where,
        include: { category: true },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      this.prisma.catalogPart.groupBy({ by: ['categoryId'], where, _count: { _all: true } }),
      this.prisma.catalogPart.count({ where: { ...where, priceUzs: { lt: 200_000 } } }),
      this.prisma.catalogPart.count({ where: { ...where, priceUzs: { gte: 200_000, lte: 500_000 } } }),
      this.prisma.catalogPart.count({ where: { ...where, seller: { ratingAvg: { gte: 4 } } } }),
    ]);

    const catIds = catGroup.map((g) => g.categoryId);
    const cats = await this.prisma.partCategory.findMany({ where: { id: { in: catIds } } });
    const catNames = new Map(cats.map((c) => [c.id, c.name]));
    const categoriesFacet = Object.fromEntries(
      catGroup.map((g) => [catNames.get(g.categoryId) ?? g.categoryId, g._count._all]),
    );

    return {
      requestId: dto.requestId ?? null,
      results: items.map((p) => ({
        id: p.id,
        title: p.title,
        price: formatUzs(p.priceUzs),
        category: p.category.name,
      })),
      total,
      durationMs: Date.now() - startedAt,
      nextPageToken: null,
      facetCounts: {
        categories: categoriesFacet,
        price: { under_200k: under200k, '200k_to_500k': between },
        minRating: { '4plus': highRated },
      },
      appliedFilters: dto.filters ?? {},
      didYouMean: null,
      suggestedCategories: Object.keys(categoriesFacet).slice(0, 5),
    };
  }

  /** Prefix suggestions (GET /v1/typeahead). */
  async typeahead(q: string, limit = 6) {
    const term = q.trim();
    const suggestions: Array<{ text: string; type: string; deeplink?: string }> = [];
    if (term) suggestions.push({ text: term, type: 'query' });

    if (term) {
      const products = await this.prisma.catalogPart.findMany({
        where: { title: { contains: term, mode: 'insensitive' } },
        select: { id: true, title: true },
        take: Math.max(0, limit - 1),
      });
      for (const p of products) {
        suggestions.push({
          text: p.title,
          type: 'product',
          deeplink: `/(tabs)/(explore)/item-detail/${p.id}`,
        });
      }
    }
    return { suggestions };
  }

  /** Brand quick-filter chips by in-stock inventory (GET /v1/search/quick-filters). */
  async quickFilters(limit = 8) {
    const grouped = await this.prisma.catalogPart.groupBy({
      by: ['brandId'],
      where: { inStock: true, brandId: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { brandId: 'desc' } },
      take: limit,
    });

    const ids = grouped.map((g) => g.brandId).filter((x): x is string => !!x);
    const brands = await this.prisma.partBrand.findMany({ where: { id: { in: ids } } });
    const brandMap = new Map(brands.map((b) => [b.id, b]));

    const items = grouped
      .filter((g) => g.brandId)
      .map((g) => {
        const b = brandMap.get(g.brandId as string);
        const label = b?.name ?? (g.brandId as string);
        return {
          id: `qf-${this.slugify(label)}`,
          label,
          slug: this.slugify(label),
          kind: 'brand',
          count: g._count._all,
          iconUrl: b?.logoUrl ?? undefined,
        };
      });

    return { items, snapshotVersion: `qf-${new Date().toISOString().slice(0, 10)}-v1` };
  }

  private slugify(s: string): string {
    return s.toLowerCase().replace(/\s+/g, '-');
  }
}
