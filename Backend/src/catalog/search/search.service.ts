import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { clampLimit } from '../../common/pagination.util';
import {
  AppLang,
  DEFAULT_APP_LANG,
  localizedCategoryName,
} from '../../common/app-lang.util';
import { formatUzs } from '../parts/part.presenter';
import { SearchDto } from './dto/search.dto';

const MAX_SEARCH_LIMIT = 50;
const MAX_TYPEAHEAD_LIMIT = 20;
const MAX_QUICK_FILTERS = 20;

@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Universal parts search with facet counts (POST /v1/search).
   *
   * `lang` decides only how categories are LABELLED; it never reaches the
   * where-clause, the grouping or the filter contract, all of which stay keyed
   * on stable category ids.
   */
  async search(dto: SearchDto, lang: AppLang = DEFAULT_APP_LANG) {
    const startedAt = Date.now();
    const q = dto.query?.trim() ?? '';
    const limit = clampLimit(dto.limit, 20, MAX_SEARCH_LIMIT);
    const categories = (dto.filters?.categories as string[] | undefined) ?? [];

    const where: Prisma.CatalogPartWhereInput = {};
    if (q) where.title = { contains: q, mode: 'insensitive' };
    if (categories.length) where.categoryId = { in: categories };

    const [total, items, catGroup, under200k, between, highRated] =
      await Promise.all([
        this.prisma.catalogPart.count({ where }),
        this.prisma.catalogPart.findMany({
          where,
          include: { category: true },
          orderBy: { createdAt: 'desc' },
          take: limit,
        }),
        this.prisma.catalogPart.groupBy({
          by: ['categoryId'],
          where,
          _count: { _all: true },
        }),
        this.prisma.catalogPart.count({
          where: { ...where, priceUzs: { lt: 200_000 } },
        }),
        this.prisma.catalogPart.count({
          where: { ...where, priceUzs: { gte: 200_000, lte: 500_000 } },
        }),
        this.prisma.catalogPart.count({
          where: { ...where, seller: { ratingAvg: { gte: 4 } } },
        }),
      ]);

    const catIds = catGroup.map((g) => g.categoryId);
    // All three names in the SAME query the facet already made — the label is
    // chosen below, in presentation, so no language is baked into the read.
    const cats = await this.prisma.partCategory.findMany({
      where: { id: { in: catIds } },
      select: {
        id: true,
        name: true,
        nameRu: true,
        nameUz: true,
        nameEn: true,
      },
    });
    const catById = new Map(cats.map((c) => [c.id, c]));
    /** The display label of a category in the request's language. */
    const labelFor = (categoryId: string): string => {
      const row = catById.get(categoryId);
      return row ? localizedCategoryName(row, lang) : categoryId;
    };

    // `facetCounts.categories` keeps its historical shape — an object keyed by
    // the category LABEL — but the label is now localized, so a `uz` request no
    // longer reads English keys. The keys were never usable as identifiers
    // anyway: `filters.categories` has always taken category IDS (see the
    // where-clause above), so nothing round-trips a key back into a filter.
    // `categories` below is the ordered, id-carrying form clients should move
    // to; both are derived from the same counts, so they cannot disagree.
    const categoriesFacet = Object.fromEntries(
      catGroup.map((g) => [labelFor(g.categoryId), g._count._all]),
    );

    // Descending by count so "suggested" means the biggest buckets, and the
    // order is stable rather than whatever the group-by returned.
    const rankedCategories = [...catGroup]
      .sort((a, b) => b._count._all - a._count._all)
      .map((g) => ({
        // The STABLE identifier — what `filters.categories` accepts.
        id: g.categoryId,
        // The localized display label. Never use this as an identifier.
        name: labelFor(g.categoryId),
        count: g._count._all,
      }));

    return {
      requestId: dto.requestId ?? null,
      results: items.map((p) => ({
        id: p.id,
        title: p.title,
        price: formatUzs(p.priceUzs),
        // Localized display label (was the internal `category.name`, which is
        // English for every seeded bucket and rendered as-is by the app).
        category: localizedCategoryName(p.category, lang),
        // The stable id alongside it, so a client that was parsing the label to
        // identify a category has an identifier to move to.
        category_id: p.categoryId,
      })),
      total,
      durationMs: Date.now() - startedAt,
      nextPageToken: null,
      facetCounts: {
        categories: categoriesFacet,
        price: { under_200k: under200k, '200k_to_500k': between },
        minRating: { '4plus': highRated },
      },
      // The id+label form of the same facet, ordered by count. Additive: it is
      // what a client should read to filter by category without guessing an id
      // from a display string.
      categories: rankedCategories,
      appliedFilters: dto.filters ?? {},
      didYouMean: null,
      // Localized display names, biggest buckets first. Historically these were
      // the internal English names; they are labels, not identifiers, and
      // `categories` above carries the ids for the same buckets.
      suggestedCategories: rankedCategories.slice(0, 5).map((c) => c.name),
    };
  }

  /** Prefix suggestions (GET /v1/typeahead). */
  async typeahead(q: string, limit = 6) {
    const safeLimit = clampLimit(limit, 6, MAX_TYPEAHEAD_LIMIT);
    const term = q.trim();
    const suggestions: Array<{
      text: string;
      type: string;
      deeplink?: string;
    }> = [];
    if (term) suggestions.push({ text: term, type: 'query' });

    if (term) {
      const products = await this.prisma.catalogPart.findMany({
        where: { title: { contains: term, mode: 'insensitive' } },
        select: { id: true, title: true },
        take: Math.max(0, safeLimit - 1),
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
    const safeLimit = clampLimit(limit, 8, MAX_QUICK_FILTERS);
    const grouped = await this.prisma.catalogPart.groupBy({
      by: ['brandId'],
      where: { inStock: true, brandId: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { brandId: 'desc' } },
      take: safeLimit,
    });

    const ids = grouped.map((g) => g.brandId).filter((x): x is string => !!x);
    const brands = await this.prisma.partBrand.findMany({
      where: { id: { in: ids } },
    });
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

    return {
      items,
      snapshotVersion: `qf-${new Date().toISOString().slice(0, 10)}-v1`,
    };
  }

  private slugify(s: string): string {
    return s.toLowerCase().replace(/\s+/g, '-');
  }
}
