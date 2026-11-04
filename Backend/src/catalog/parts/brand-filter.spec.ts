// GET /v1/catalog/parts?brand=<part-brand id> over a 132-part catalogue
// (brand-catalogue.test-util): the brand narrows the WHOLE catalogue before it
// is counted, sorted and paged, so each page holds only that brand, the total
// is the brand's, and following next_page from page 1 reaches every part of
// it — including the 50 Bosch parts the unfiltered first page never shows.
// The listing's real predicates run over in-memory rows (where-eval), and the
// rows come back through the real presenter.

import { PartsService } from './parts.service';
import { ListPartsQueryDto } from './dto/list-parts.query.dto';
import { selectIds } from '../compatibility/where-eval.test-util';
import {
  BOSCH,
  CATALOGUE,
  FEBI,
  GATES,
  MANN,
  NO_DISCOUNTS,
  SACHS,
  catalogPrisma,
  listedOf,
} from './brand-catalogue.test-util';

type Listing = Awaited<ReturnType<PartsService['list']>>;

function service() {
  const prisma = catalogPrisma();
  return {
    svc: new PartsService(prisma as never, NO_DISCOUNTS as never),
    prisma,
  };
}

const list = (query: ListPartsQueryDto) => service().svc.list(query);

/** Every page of a listing, page 1 on, as far as next_page leads — the way
 *  the app scrolls it. */
async function scrolled(query: ListPartsQueryDto): Promise<Listing[]> {
  const pages: Listing[] = [];
  for (let next: number | null = 1; next !== null;) {
    const page = await list({ ...query, page: next, page_size: 24 });
    pages.push(page);
    next = page.next_page;
    if (pages.length > 10) throw new Error('next_page never runs out');
  }
  return pages;
}

const ids = (page: Listing) => page.items.map((i) => i.id);
const brandsOn = (page: Listing) => page.items.map((i) => i.brand?.id ?? null);
/** The brand facet as id → count. */
const facet = (page: Listing) =>
  Object.fromEntries(
    page.facets.brands.map((b): [string, number] => [b.id ?? '', b.count]),
  );

const ALL_BOSCH = listedOf(BOSCH);

describe('a brand narrows the whole catalogue before it is paged', () => {
  it('the unfiltered first page holds 2 of the 52 Bosch parts — the rest come later', async () => {
    const first = await list({ page: 1, page_size: 24 });
    expect(brandsOn(first).filter((b) => b === BOSCH)).toHaveLength(2);
    expect(ALL_BOSCH).toHaveLength(52);
  });

  it('lists every Bosch part of the catalogue, in the listing order', async () => {
    const pages = await scrolled({ brand: BOSCH });
    expect(pages.flatMap(ids)).toEqual(ALL_BOSCH);
  });

  it('serves only Bosch, on the first page and on every page after it', async () => {
    for (const page of await scrolled({ brand: BOSCH })) {
      expect(new Set(brandsOn(page))).toEqual(new Set([BOSCH]));
    }
  });

  it('counts the whole brand: total 52 on every page, whichever is asked', async () => {
    const pages = await scrolled({ brand: BOSCH });
    expect(pages.map((p) => p.total)).toEqual([52, 52, 52]);
  });

  it('pages 24, 24, 4 — next_page 2, then 3, then none', async () => {
    const pages = await scrolled({ brand: BOSCH });
    expect(pages.map((p) => p.items.length)).toEqual([24, 24, 4]);
    expect(pages.map((p) => p.next_page)).toEqual([2, 3, null]);
  });

  it('repeats no part across the pages and drops none', async () => {
    const shown = (await scrolled({ brand: BOSCH })).flatMap(ids);
    expect(new Set(shown).size).toBe(shown.length);
    expect(new Set(shown)).toEqual(new Set(ALL_BOSCH));
  });

  it('cuts the page out of the brand predicate, the one it counts', async () => {
    const { svc, prisma } = service();
    await svc.list({ brand: BOSCH, page: 2, page_size: 24 });
    const [page] = prisma.paged;
    expect(page).toMatchObject({ skip: 24, take: 24 });
    expect(selectIds(CATALOGUE, page.where)).toEqual(ALL_BOSCH);
    expect(prisma.counted).toEqual([page.where]);
  });

  it('never lists or counts a part a buyer may not see, nor a part of no brand', async () => {
    const shown = (await scrolled({ brand: BOSCH })).flatMap(ids);
    expect(shown).not.toContain('p132'); // Bosch, but no photo
    expect(shown).not.toContain('p131'); // no brand
  });
});

describe('dropping or changing the brand', () => {
  it('without a brand the whole catalogue lists again', async () => {
    const pages = await scrolled({});
    expect(pages[0].total).toBe(131);
    expect(new Set(pages.flatMap(brandsOn))).toEqual(
      new Set([BOSCH, MANN, GATES, FEBI, SACHS, null]),
    );
  });

  it('another brand is its own listing, from its own first page', async () => {
    const gates = await list({ brand: GATES, page: 1, page_size: 24 });
    expect(gates.total).toBe(33);
    expect(ids(gates)).toEqual(listedOf(GATES).slice(0, 24));
    expect(gates.next_page).toBe(2);
  });

  it('several brands, comma-separated, list exactly their parts', async () => {
    const pages = await scrolled({ brand: `${BOSCH},${MANN}` });
    const both = CATALOGUE.map((p) => p.id).filter(
      (id) => ALL_BOSCH.includes(id) || listedOf(MANN).includes(id),
    );
    expect(pages.flatMap(ids)).toEqual(both);
    expect(pages[0].total).toBe(62);
  });

  it('a brand no part carries lists nothing', async () => {
    const none = await list({ brand: 'brand_nobody', page: 1, page_size: 24 });
    expect(none).toMatchObject({ items: [], total: 0, next_page: null });
  });
});

describe('the brand composes with every other filter', () => {
  // brand + X must list exactly X's parts of that brand: the brand filter
  // narrows the other filters' listing, it never widens or replaces it.
  it.each<[string, ListPartsQueryDto]>([
    ['a system root (main category)', { category: 'brake-system' }],
    ['a subcategory', { category: 'front-brake-pads' }],
    ['a Chevrolet model', { make: 'Chevrolet', model: 'Cobalt' }],
    ['a BYD model', { make: 'BYD', model: 'Song Plus' }],
    ['a Volkswagen model', { make: 'Volkswagen', model: 'Polo' }],
    ['a search', { q: 'pad' }],
    ['GM only', { gm_only: 'true' }],
    ['OEM only', { oem_only: 'true' }],
    ['a region', { region: ['europe'] }],
    [
      'a model, a subcategory and a search at once',
      {
        make: 'Chevrolet',
        model: 'Cobalt',
        category: 'front-brake-pads',
        q: 'pad',
      },
    ],
  ])('%s', async (_label, other) => {
    const boschOfOther = (await scrolled(other))
      .flatMap((p) => p.items)
      .filter((i) => i.brand?.id === BOSCH)
      .map((i) => i.id);
    // Neither vacuous nor the whole brand: the combination really narrows.
    expect(boschOfOther.length).toBeGreaterThan(0);
    expect(boschOfOther.length).toBeLessThan(ALL_BOSCH.length);

    const pages = await scrolled({ ...other, brand: BOSCH });
    expect(pages.flatMap(ids)).toEqual(boschOfOther);
    expect(pages.map((p) => p.total)).toEqual(
      pages.map(() => boschOfOther.length),
    );
  });

  it('sorted by price, the pages run through the whole brand in price order', async () => {
    const pages = await scrolled({ brand: BOSCH, sort: 'price_asc' });
    const prices = pages.flatMap((p) => p.items.map((i) => i.price_uzs));
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    expect(new Set(pages.flatMap(ids))).toEqual(new Set(ALL_BOSCH));
  });
});

describe('the brand facet', () => {
  it('counts every brand over the whole result — Sachs too, absent from page 1', async () => {
    const first = await list({ page: 1, page_size: 24 });
    expect(brandsOn(first)).not.toContain(SACHS);
    expect(facet(first)).toEqual({
      [BOSCH]: 52,
      [GATES]: 33,
      [SACHS]: 26,
      [MANN]: 10,
      [FEBI]: 9,
    });
  });

  it('names each brand from the part-brand directory', async () => {
    const names = (await list({})).facets.brands.map((b) => b.name);
    expect(names.sort()).toEqual([
      'Bosch',
      'Febi',
      'Gates',
      'MANN-FILTER',
      'Sachs',
    ]);
  });

  it('keeps every brand on offer, counts unchanged, once brands are picked', async () => {
    const offered = facet(await list({}));
    expect(facet(await list({ brand: BOSCH }))).toEqual(offered);
    expect(facet(await list({ brand: `${BOSCH},${MANN}` }))).toEqual(offered);
  });

  it('still follows every other filter', async () => {
    const brakes = facet(await list({ category: 'brake-system' }));
    expect(
      facet(await list({ category: 'brake-system', brand: BOSCH })),
    ).toEqual(brakes);
    expect(brakes[BOSCH]).toBe(
      (await list({ category: 'brake-system', brand: BOSCH })).total,
    );
  });
});

describe('requests side by side', () => {
  it('concurrent pages of different brands each answer for their own brand', async () => {
    const { svc } = service();
    const [bosch2, mann1, bosch3, all1] = await Promise.all([
      svc.list({ brand: BOSCH, page: 2, page_size: 24 }),
      svc.list({ brand: MANN, page: 1, page_size: 24 }),
      svc.list({ brand: BOSCH, page: 3, page_size: 24 }),
      svc.list({ page: 1, page_size: 24 }),
    ]);
    expect(ids(bosch2)).toEqual(ALL_BOSCH.slice(24, 48));
    expect(ids(bosch3)).toEqual(ALL_BOSCH.slice(48));
    expect(ids(mann1)).toEqual(listedOf(MANN));
    expect(all1.total).toBe(131);
    expect(brandsOn(all1).filter((b) => b === BOSCH)).toHaveLength(2);
  });
});
