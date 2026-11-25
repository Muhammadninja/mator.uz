import { loadPhotoRequestCard } from './photo-request-card';

function prisma(part: unknown, vehicles: (string | null)[], code: string | null = null) {
  return {
    catalogPart: { findUnique: jest.fn(async () => part) },
    photoRequest: { findMany: jest.fn(async () => vehicles.map((vehicleLabel) => ({ vehicleLabel }))) },
    stock: { findFirst: jest.fn(async () => (code ? { sourceCode: code } : null)) },
  };
}

const PART = {
  title: 'Уплотнитель передней двери, правая',
  partBrandName: null,
  brand: { name: 'Chevrolet' },
  oemNumbers: ['94779211'],
  gmNumbers: [],
  condition: 'NEW',
  priceUzs: { toString: () => '144000' } as unknown,
  isUniversal: false,
  category: { nameRu: 'Кузов и экстерьер' },
  seller: { name: 'Mator' },
  fits: [
    { makeName: 'Chevrolet', modelName: 'Cobalt' },
    { makeName: 'Chevrolet', modelName: 'Gentra' },
    { makeName: 'Chevrolet', modelName: 'Lacetti' },
    { makeName: 'Chevrolet', modelName: 'Malibu' },
    { makeName: 'Chevrolet', modelName: 'Nexia 3' },
    { makeName: 'Chevrolet', modelName: 'Spark' },
  ],
  makeFits: [],
};

describe('loadPhotoRequestCard', () => {
  it('says what the part is, what it fits and which cars the customers drive', async () => {
    const db = prisma({ ...PART, priceUzs: 144000 }, ['2026 BYD Song Plus', null, '2026 BYD Song Plus'], '94779211');
    const card = await loadPhotoRequestCard(db as never, 'part_stock_6567', 'fallback');
    expect(card).toEqual({
      partId: 'part_stock_6567',
      partTitle: 'Уплотнитель передней двери, правая',
      brand: 'Chevrolet',
      oemNumbers: ['94779211'],
      gmNumbers: [],
      category: 'Кузов и экстерьер',
      condition: 'NEW',
      priceUzs: 144000,
      fits: ['Chevrolet Cobalt', 'Chevrolet Gentra', 'Chevrolet Lacetti', 'Chevrolet Malibu', 'Chevrolet Nexia 3'],
      moreFits: 1,
      customerVehicles: ['2026 BYD Song Plus'],
      seller: 'Mator',
      code1c: '94779211',
      waiting: 3,
      url: 'https://mator.uz/p/part_stock_6567',
    });
  });

  it('falls back to the make list, then says universal', async () => {
    const makes = await loadPhotoRequestCard(
      prisma({ ...PART, priceUzs: 1, fits: [], makeFits: [{ makeName: 'Kia' }] }, []) as never,
      'seed_1',
      'x',
    );
    expect(makes.fits).toEqual(['Kia']);
    expect(makes.code1c).toBeNull();
    const universal = await loadPhotoRequestCard(
      prisma({ ...PART, priceUzs: 1, isUniversal: true }, []) as never,
      'seed_1',
      'x',
    );
    expect(universal.fits).toEqual(['универсальная']);
    expect(universal.moreFits).toBe(0);
  });

  it('still makes a card for a part that left the catalog', async () => {
    const card = await loadPhotoRequestCard(prisma(null, [null]) as never, 'part_stock_9', 'Старое название');
    expect(card.partTitle).toBe('Старое название');
    expect(card.url).toBeNull();
    expect(card.waiting).toBe(1);
  });
});
