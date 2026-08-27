/**
 * Localization of the search response.
 *
 * The load-bearing distinction under test is IDENTIFIER vs LABEL. Search has
 * both, and they had been conflated: `facetCounts.categories` was keyed by the
 * internal English `category.name`, so an Uzbek buyer read English facet keys.
 * The rule these tests pin is that language moves the LABELS and nothing else —
 * ids, counts, ordering, the where-clause and the filter contract are byte-for-
 * byte identical in every language.
 */

import { SearchService } from './search.service';
import { createPrismaMock, PrismaMock } from '../../../test/utils/harness';

const CATEGORY = {
  id: 'brake-pads',
  name: 'Brake pads',
  nameRu: 'Тормозные колодки',
  nameUz: 'Tormoz kolodkalari',
  nameEn: 'Brake pads',
};

const OIL = {
  id: 'motor-oil',
  name: 'Motor oil',
  nameRu: 'Моторное масло',
  nameUz: 'Motor moyi',
  nameEn: 'Motor oil',
};

/** The localized label of each category, per language. */
const LABEL = {
  ru: { [CATEGORY.id]: 'Тормозные колодки', [OIL.id]: 'Моторное масло' },
  uz: { [CATEGORY.id]: 'Tormoz kolodkalari', [OIL.id]: 'Motor moyi' },
  en: { [CATEGORY.id]: 'Brake pads', [OIL.id]: 'Motor oil' },
} as const;

describe('SearchService — category localization', () => {
  let prisma: PrismaMock;
  let svc: SearchService;

  beforeEach(() => {
    prisma = createPrismaMock();
    svc = new SearchService(prisma);

    prisma.catalogPart.count
      .mockResolvedValueOnce(3) // total
      .mockResolvedValueOnce(1) // under 200k
      .mockResolvedValueOnce(1) // 200k–500k
      .mockResolvedValueOnce(0); // 4★+
    prisma.catalogPart.findMany.mockResolvedValue([
      {
        id: 'part_1',
        title: 'Bosch brake pad set',
        priceUzs: 185000,
        categoryId: CATEGORY.id,
        category: CATEGORY,
      },
    ]);
    // Oil is the BIGGER bucket, so a correct implementation ranks it first
    // regardless of how the group-by happened to order the rows.
    prisma.catalogPart.groupBy.mockResolvedValue([
      { categoryId: CATEGORY.id, _count: { _all: 1 } },
      { categoryId: OIL.id, _count: { _all: 2 } },
    ]);
    prisma.partCategory.findMany.mockResolvedValue([CATEGORY, OIL]);
  });

  describe('suggestedCategories follow the request language', () => {
    it.each(['ru', 'uz', 'en'] as const)('renders %s labels', async (lang) => {
      const res = await svc.search({ query: 'brake' } as never, lang);

      expect(res.suggestedCategories).toEqual([
        LABEL[lang][OIL.id],
        LABEL[lang][CATEGORY.id],
      ]);
    });

    it('orders suggestions by count, biggest bucket first', async () => {
      const res = await svc.search({ query: 'brake' } as never, 'en');
      expect(res.suggestedCategories[0]).toBe('Motor oil'); // 2 parts
      expect(res.suggestedCategories[1]).toBe('Brake pads'); // 1 part
    });
  });

  describe('facetCounts.categories is keyed by the localized label', () => {
    it.each(['ru', 'uz', 'en'] as const)('keys %s facets', async (lang) => {
      const res = await svc.search({ query: 'brake' } as never, lang);

      expect(res.facetCounts.categories).toEqual({
        [LABEL[lang][CATEGORY.id]]: 1,
        [LABEL[lang][OIL.id]]: 2,
      });
      // The internal English name must not leak into a non-English response.
      if (lang !== 'en') {
        expect(Object.keys(res.facetCounts.categories)).not.toContain(
          'Brake pads',
        );
      }
    });

    it('reports the same COUNTS in every language', async () => {
      const counts = await Promise.all(
        (['ru', 'uz', 'en'] as const).map(async (lang) => {
          const fresh = new SearchService(prisma);
          prisma.catalogPart.count.mockResolvedValue(3);
          const res = await fresh.search({ query: 'brake' } as never, lang);
          return Object.values(res.facetCounts.categories).sort();
        }),
      );
      expect(counts[0]).toEqual(counts[1]);
      expect(counts[1]).toEqual(counts[2]);
    });
  });

  describe('the `categories` facet carries stable ids beside the labels', () => {
    it('pairs each id with its localized name and count', async () => {
      const res = await svc.search({ query: 'brake' } as never, 'uz');

      expect(res.categories).toEqual([
        { id: OIL.id, name: 'Motor moyi', count: 2 },
        { id: CATEGORY.id, name: 'Tormoz kolodkalari', count: 1 },
      ]);
    });

    // The whole point of the id/label split: a client filters by the id it read
    // here, and that id is the same string whatever language it asked in.
    it.each(['ru', 'uz', 'en'] as const)(
      'returns identical ids for %s',
      async (lang) => {
        const res = await svc.search({ query: 'brake' } as never, lang);
        expect(res.categories.map((c) => c.id)).toEqual([OIL.id, CATEGORY.id]);
      },
    );

    it('agrees with suggestedCategories, which is derived from it', async () => {
      const res = await svc.search({ query: 'brake' } as never, 'ru');
      expect(res.suggestedCategories).toEqual(
        res.categories.slice(0, 5).map((c) => c.name),
      );
    });
  });

  describe('result rows', () => {
    it.each(['ru', 'uz', 'en'] as const)(
      'labels a result category in %s and keeps its id',
      async (lang) => {
        const res = await svc.search({ query: 'brake' } as never, lang);

        expect(res.results[0].category).toBe(LABEL[lang][CATEGORY.id]);
        expect(res.results[0].category_id).toBe(CATEGORY.id);
      },
    );
  });

  describe('language never reaches the query', () => {
    // Filtering, grouping and the category lookup must be identical across
    // languages — otherwise a localized label has leaked into a where-clause.
    it('issues the same Prisma calls whatever the language', async () => {
      const argsPerLang: unknown[][] = [];
      for (const lang of ['ru', 'uz', 'en'] as const) {
        prisma = createPrismaMock();
        prisma.catalogPart.count.mockResolvedValue(3);
        prisma.catalogPart.findMany.mockResolvedValue([]);
        prisma.catalogPart.groupBy.mockResolvedValue([
          { categoryId: CATEGORY.id, _count: { _all: 1 } },
        ]);
        prisma.partCategory.findMany.mockResolvedValue([CATEGORY]);

        await new SearchService(prisma).search(
          { query: 'brake', filters: { categories: [CATEGORY.id] } } as never,
          lang,
        );
        argsPerLang.push([
          prisma.catalogPart.findMany.mock.calls[0][0],
          prisma.catalogPart.groupBy.mock.calls[0][0],
          prisma.partCategory.findMany.mock.calls[0][0],
        ]);
      }
      expect(argsPerLang[0]).toEqual(argsPerLang[1]);
      expect(argsPerLang[1]).toEqual(argsPerLang[2]);
    });

    it('filters on the category ID, never on a display name', async () => {
      await svc.search(
        { query: 'brake', filters: { categories: [CATEGORY.id] } } as never,
        'uz',
      );
      const where = prisma.catalogPart.findMany.mock.calls[0][0].where;
      expect(where.categoryId).toEqual({ in: [CATEGORY.id] });
      expect(JSON.stringify(where)).not.toContain('Tormoz kolodkalari');
    });

    // One lookup for every category in the facet — the localized names ride
    // along in the SAME query rather than costing a round-trip per row.
    it('loads all three names in a single category query', async () => {
      await svc.search({ query: 'brake' } as never, 'uz');

      expect(prisma.partCategory.findMany).toHaveBeenCalledTimes(1);
      expect(
        prisma.partCategory.findMany.mock.calls[0][0].select,
      ).toMatchObject({ nameRu: true, nameUz: true, nameEn: true });
    });
  });

  describe('defaults and unknown categories', () => {
    it('defaults to Russian when the caller passes no language', async () => {
      const res = await svc.search({ query: 'brake' } as never);
      expect(res.results[0].category).toBe('Тормозные колодки');
    });

    // A part filed under a category row the lookup did not return must not
    // produce an empty label — the id is a poor label but a truthful one.
    it('falls back to the id when a category row is missing', async () => {
      prisma.partCategory.findMany.mockResolvedValue([]);
      const res = await svc.search({ query: 'brake' } as never, 'uz');

      expect(res.categories.map((c) => c.name)).toEqual([OIL.id, CATEGORY.id]);
      expect(res.suggestedCategories.every((n) => n.length > 0)).toBe(true);
    });
  });
});
