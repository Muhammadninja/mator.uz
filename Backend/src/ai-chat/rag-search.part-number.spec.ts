/**
 * Wave 5: the AI catalog lookup finds a part by its number, exactly.
 *
 * The chat's extracted `part_name` can be a bare number ("96879797") or a
 * number beside words ("фильтр 96.943.770"). Such a number is looked up as an
 * exact GM/OEM entry (never a prefix, never through a cross-reference), and a
 * part carrying it ranks above any part that merely matched a word.
 */
import { Prisma } from '@prisma/client';
import { RagSearchService } from './rag-search.service';
import {
  createPrismaMock,
  fakeDiscounts,
  PrismaMock,
} from '../../test/utils/harness';

const CATEGORY = {
  id: 'oil-filters',
  name: 'Oil filters',
  nameRu: 'Масляные фильтры',
  nameUz: 'Moy filtrlari',
  nameEn: 'Oil filters',
};

function row(
  id: string,
  title: string,
  gm: string[] = [],
  oem: string[] = [],
  price = 100_000,
) {
  return {
    id,
    title,
    priceUzs: new Prisma.Decimal(price),
    categoryId: CATEGORY.id,
    sellerId: 'seller_1',
    category: CATEGORY,
    brand: null,
    gmNumbers: gm,
    oemNumbers: oem,
    isUniversal: false,
    compatibilities: [],
    fitmentBindings: [],
  };
}

describe('RagSearchService — part numbers', () => {
  let prisma: PrismaMock;
  let svc: RagSearchService;

  beforeEach(() => {
    prisma = createPrismaMock();
    svc = new RagSearchService(prisma, fakeDiscounts());
  });

  const whereOr = (): unknown[] =>
    (
      prisma.catalogPart.findMany.mock.calls[0][0] as {
        where: { OR: unknown[] };
      }
    ).where.OR;

  it('looks a bare number up exactly in both arrays', async () => {
    prisma.catalogPart.findMany.mockResolvedValue([]);
    await svc.searchInStock({
      partName: '96.943.770',
      brand: null,
      model: null,
    });
    expect(whereOr()).toEqual(
      expect.arrayContaining([
        { oemNumbers: { has: '96943770' } },
        { gmNumbers: { has: '96943770' } },
      ]),
    );
    // Never the fragments the word tokenizer cuts the number into.
    expect(JSON.stringify(whereOr())).not.toContain('{"has":"96"}');
  });

  it('a part found only by its number is returned, ahead of word matches', async () => {
    prisma.catalogPart.findMany.mockResolvedValue([
      row('word_match', 'Фильтр масляный', [], [], 50_000),
      row('number_match', 'Элемент ДВС', ['96879797'], [], 90_000),
    ]);
    const res = await svc.searchInStock({
      partName: 'фильтр 96879797',
      brand: null,
      model: null,
    });
    expect(res.items.map((i) => i.id)).toEqual(['number_match', 'word_match']);
  });

  it('title matches beyond the candidate limit cannot crowd out an exact-number part', async () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      row(`title_${i}`, 'Фильтр 96879797 аналог'),
    );
    // Like the database with LIMIT 60: a read that also matches titles is full
    // of title matches; only the number-only read reaches the exact part.
    prisma.catalogPart.findMany.mockImplementation(
      (args: { where: { OR: unknown[] } }) =>
        Promise.resolve(
          JSON.stringify(args.where.OR).includes('title')
            ? many
            : [row('number_match', 'Элемент ДВС', ['96879797'])],
        ),
    );
    const res = await svc.searchInStock({
      partName: '96879797',
      brand: null,
      model: null,
    });
    expect(res.items[0].id).toBe('number_match');
  });

  it('a number one digit off or without its leading zero is not an exact match', async () => {
    prisma.catalogPart.findMany.mockResolvedValue([
      row('off_by_one', 'Элемент', ['96879798']),
      row('no_zero', 'Элемент', [], ['986452041']),
    ]);
    const res = await svc.searchInStock({
      partName: '0986452041',
      brand: null,
      model: null,
    });
    expect(res.found).toBe(false);
  });

  it('a short number beside words is not a part number ("Нексия 3", "ВАЗ 2106")', async () => {
    prisma.catalogPart.findMany.mockResolvedValue([]);
    await svc.searchInStock({
      partName: 'колодки ВАЗ 2106',
      brand: null,
      model: null,
    });
    expect(JSON.stringify(whereOr())).not.toContain('"has"');
  });
});
