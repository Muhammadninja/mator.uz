import { BadRequestException, Injectable } from '@nestjs/common';
import { sellableWhere } from '../../orders/inventory/inventory-availability';
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
import { BUYER_LISTED_PART } from '../buyer-visibility';
import {
  loadCategoryTreeScope,
  visibleCategoryWhere,
} from '../categories/category-tree-scope';
import {
  categorySubtreeWhere,
  partOrderBy,
  partTextWhere,
} from '../parts/parts.service';
import { DiscountService } from '../../sales/discount.service';

const MAX_SEARCH_LIMIT = 50;
const MAX_TYPEAHEAD_LIMIT = 20;
const MAX_QUICK_FILTERS = 20;
const MAX_CATEGORY_FILTERS = 20;

/** A position in the result order. Opaque to clients, like the listing's own paging. */
function encodePageToken(offset: number): string {
  return Buffer.from(JSON.stringify([offset])).toString('base64url');
}

function decodePageToken(token: string): number {
  try {
    const [offset] = JSON.parse(Buffer.from(token, 'base64url').toString()) as unknown[];
    if (Number.isSafeInteger(offset) && (offset as number) >= 0) return offset as number;
  } catch {
    // Falls through to the refusal below.
  }
  throw new BadRequestException('Invalid pageToken');
}

@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly discounts: DiscountService,
  ) {}

  /** What every buyer-facing search read starts from. */
  private async listedParts(): Promise<Prisma.CatalogPartWhereInput[]> {
    const visible = visibleCategoryWhere(await loadCategoryTreeScope(this.prisma));
    return visible ? [BUYER_LISTED_PART, visible] : [BUYER_LISTED_PART];
  }

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
    const requested = dto.filters?.categories;
    const categories = (Array.isArray(requested) ? requested : [])
      .filter((c): c is string => typeof c === 'string' && c.length > 0)
      .slice(0, MAX_CATEGORY_FILTERS);
    const offset = dto.pageToken ? decodePageToken(dto.pageToken) : 0;

    // The listing's own definitions: only buyer-listed parts in visible categories,
    // title or article number, a category with everything beneath it. Kept under AND
    // so the `seller` rating filter below can still be spread in beside it.
    const conditions = await this.listedParts();
    if (q) conditions.push(partTextWhere(q));
    if (categories.length) {
      conditions.push({ OR: categories.map(categorySubtreeWhere) });
    }
    const where: Prisma.CatalogPartWhereInput = { AND: conditions };
    const [total, fetched, catGroup, under200k, between, highRated, sales] =
      await Promise.all([
        this.prisma.catalogPart.count({ where }),
        this.prisma.catalogPart.findMany({
          where,
          include: { category: true },
          orderBy: partOrderBy(dto.sortBy),
          skip: offset,
          // One past the page says whether another page exists.
          take: limit + 1,
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
        this.discounts.loadActiveSales(),
      ]);
    const items = fetched.slice(0, limit);
    const nextPageToken =
      fetched.length > limit ? encodePageToken(offset + limit) : null;

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
        // What the buyer pays, the same figure as the listing and the detail.
        price: formatUzs(
          this.discounts.calculateDiscount(
            Number(p.priceUzs),
            { id: p.id, categoryId: p.categoryId, sellerId: p.sellerId },
            sales,
          ).finalPrice,
        ),
        // Localized display label (was the internal `category.name`, which is
        // English for every seeded bucket and rendered as-is by the app).
        category: localizedCategoryName(p.category, lang),
        // The stable id alongside it, so a client that was parsing the label to
        // identify a category has an identifier to move to.
        category_id: p.categoryId,
      })),
      total,
      durationMs: Date.now() - startedAt,
      nextPageToken,
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
        where: { AND: [...(await this.listedParts()), partTextWhere(term)] },
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
      where: {
        AND: [await this.listedParts(), sellableWhere(this.prisma)].flat(),
        inStock: true,
        brandId: { not: null },
      },
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
