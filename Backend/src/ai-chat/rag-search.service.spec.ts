/**
 * The category context RAG hands to the LLM (and to the chat client) must be in
 * the language the buyer is WRITING IN. Previously it was `category.name`, the
 * internal canonical label — English for every seeded bucket — so a Russian
 * buyer's model context said "Brake pads" and the item card rendered it too.
 *
 * The language is not invented here: the chat already detects it once (see
 * common/i18n.util) and passes it in, which is why these tests exercise the
 * chat's own `SupportedLang` values, Uzbek's two scripts included.
 */

import { Prisma } from '@prisma/client';
import { RagSearchService } from './rag-search.service';
import { createPrismaMock, fakeDiscounts, PrismaMock } from '../../test/utils/harness';

const CATEGORY = {
  id: 'brake-pads',
  name: 'Brake pads',
  nameRu: 'Тормозные колодки',
  nameUz: 'Tormoz kolodkalari',
  nameEn: 'Brake pads',
};

const ROW = {
  id: 'part_1',
  title: 'Bosch tormoz kolodka',
  priceUzs: new Prisma.Decimal(185000),
  categoryId: CATEGORY.id,
  sellerId: 'seller_1',
  category: CATEGORY,
  brand: { name: 'Bosch' },
};

describe('RagSearchService — localized category context', () => {
  let prisma: PrismaMock;
  let svc: RagSearchService;

  beforeEach(() => {
    prisma = createPrismaMock();
    svc = new RagSearchService(prisma, fakeDiscounts());
    prisma.catalogPart.findMany.mockResolvedValue([ROW]);
  });

  it.each([
    ['ru', 'Тормозные колодки'],
    ['en', 'Brake pads'],
  ] as const)('labels the category in %s', async (lang, expected) => {
    const res = await svc.searchInStock({ partName: 'tormoz', brand: null, model: null }, lang);

    expect(res.found).toBe(true);
    expect(res.items[0].category).toBe(expected);
  });

  // A category has ONE Uzbek name, written in Latin. Both detected Uzbek
  // scripts therefore resolve to it — a Cyrillic-writing buyer sees the Latin
  // Uzbek name, which is closer to their language than Russian would be.
  it.each(['uz_lat', 'uz_cyr'] as const)(
    'maps the detected script %s onto the single Uzbek name',
    async (lang) => {
      const res = await svc.searchInStock(
        { partName: 'tormoz', brand: null, model: null },
        lang,
      );
      expect(res.items[0].category).toBe('Tormoz kolodkalari');
    },
  );

  it('defaults to Russian when the caller passes no language', async () => {
    const res = await svc.searchInStock({ partName: 'tormoz', brand: null, model: null });
    expect(res.items[0].category).toBe('Тормозные колодки');
  });

  it('never leaks the internal English name to a non-English chat', async () => {
    for (const lang of ['ru', 'uz_lat', 'uz_cyr'] as const) {
      const res = await svc.searchInStock(
        { partName: 'tormoz', brand: null, model: null },
        lang,
      );
      expect(res.items[0].category).not.toBe(CATEGORY.name);
    }
  });

  // The id is what any downstream logic keys on; it must not follow the label.
  it('keeps the category id stable across languages', async () => {
    for (const lang of ['ru', 'uz_lat', 'en'] as const) {
      const res = await svc.searchInStock(
        { partName: 'tormoz', brand: null, model: null },
        lang,
      );
      expect(res.items[0].categoryId).toBe(CATEGORY.id);
    }
  });

  // Retrieval is language-independent: the same request must return the same
  // parts, at the same prices, whatever language it was written in.
  it('matches and prices identically in every language', async () => {
    const results = await Promise.all(
      (['ru', 'uz_lat', 'en'] as const).map((lang) =>
        svc.searchInStock({ partName: 'tormoz', brand: null, model: null }, lang),
      ),
    );
    const withoutLabel = results.map((r) =>
      r.items.map(({ category, ...rest }) => rest),
    );
    expect(withoutLabel[0]).toEqual(withoutLabel[1]);
    expect(withoutLabel[1]).toEqual(withoutLabel[2]);
  });

  it('does not put a display label into the search query', async () => {
    await svc.searchInStock({ partName: 'tormoz', brand: null, model: null }, 'uz_lat');
    const where = JSON.stringify(prisma.catalogPart.findMany.mock.calls[0][0].where);
    expect(where).not.toContain('Tormoz kolodkalari');
    expect(where).not.toContain('Тормозные колодки');
  });

  it('reports a null category for a part that has none', async () => {
    prisma.catalogPart.findMany.mockResolvedValue([
      { ...ROW, category: null, categoryId: null },
    ]);
    const res = await svc.searchInStock(
      { partName: 'tormoz', brand: null, model: null },
      'uz_lat',
    );
    expect(res.items[0].category).toBeNull();
    expect(res.items[0].categoryId).toBeNull();
  });
});
