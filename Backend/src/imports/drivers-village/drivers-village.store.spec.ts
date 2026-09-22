import {
  FakeDb,
  driversVillageFixture,
} from '../../../test/utils/drivers-village-fake-db';
import { numberLabels, writePosition } from './drivers-village.store';
import type { PositionWrite } from './drivers-village.types';

function write(over: Partial<PositionWrite> = {}): PositionWrite {
  return {
    code1c: 'БП-01071006',
    priceUzs: '2031708.59',
    quantity: 2,
    unit: 'PCS',
    product: {
      title: 'Стартер',
      gmNumbers: [],
      oemNumbers: ['13520817'],
      categoryId: 'starters',
      vehicleCategoryId: 'electrical-and-lighting',
      mainCategory: null,
      vehicleCategory: 'ELECTRICAL_AND_LIGHTING',
      isUniversal: false,
    },
    models: [
      { make: 'Chevrolet', model: 'Malibu' },
      { make: 'Chevrolet', model: 'Tracker' },
    ],
    make: null,
    ...over,
  };
}

describe('writePosition (Prisma write contract)', () => {
  it('keys the stock on (seller, DRIVERS_VILLAGE_1C, code_1c) and creates product + stock once', async () => {
    const db = new FakeDb(driversVillageFixture());
    const first = await writePosition(db.tx, 7, write());
    const second = await writePosition(db.tx, 7, write({ priceUzs: '1.00' }));

    expect(first.created).toBe(true);
    expect(second).toMatchObject({
      created: false,
      stockId: first.stockId,
      productId: first.productId,
    });
    expect(db.state.stocks).toEqual([
      expect.objectContaining({
        sellerId: 7,
        sourceSystem: 'DRIVERS_VILLAGE_1C',
        sourceCode: 'БП-01071006',
        priceUzs: '1',
      }),
    ]);
    expect(db.state.products).toHaveLength(1);
  });

  it('never writes photos, image_url, description, rating or the Telegram GM key', async () => {
    const db = new FakeDb(driversVillageFixture());
    const { productId } = await writePosition(db.tx, 7, write());
    const p = db.state.products[0];
    Object.assign(p, {
      imageUrl: 'https://img/a.jpg',
      description: 'manual',
      ratingAvg: '4.5',
      reviewCount: 3,
    });
    db.state.productImages.push({ productId, url: 'https://img/a.jpg' });

    await writePosition(
      db.tx,
      7,
      write({ product: { ...write().product, title: 'Стартер новый' } }),
    );

    expect(db.calls.some((c) => c.startsWith('productImage'))).toBe(false);
    expect(db.state.productImages).toEqual([
      { productId, url: 'https://img/a.jpg' },
    ]);
    expect(db.state.products[0]).toMatchObject({
      title: 'Стартер новый',
      gmNumber: null,
      imageUrl: 'https://img/a.jpg',
      description: 'manual',
      ratingAvg: '4.5',
      reviewCount: 3,
    });
  });

  it('reconciles fitment: clear-then-recreate, so repeats never duplicate links', async () => {
    const db = new FakeDb(driversVillageFixture());
    for (let i = 0; i < 3; i += 1) await writePosition(db.tx, 7, write());
    expect(db.state.partModels).toHaveLength(2);
    expect(db.state.carModels.map((m) => m.name).sort()).toEqual([
      'Malibu',
      'Tracker',
    ]);
    expect(db.state.brands.map((b) => b.name)).toEqual(['Chevrolet']);
    expect(db.calls.indexOf('partModel.deleteMany')).toBeLessThan(
      db.calls.indexOf('partModel.upsert'),
    );

    // Specific → make-wide: model links are dropped, one make link replaces them.
    await writePosition(db.tx, 7, write({ models: [], make: 'Chevrolet' }));
    await writePosition(db.tx, 7, write({ models: [], make: 'Chevrolet' }));
    expect(db.state.partModels).toHaveLength(0);
    expect(db.state.partMakes).toHaveLength(1);

    // Make-wide → universal: every link is dropped.
    await writePosition(
      db.tx,
      7,
      write({
        models: [],
        make: null,
        product: { ...write().product, isUniversal: true },
      }),
    );
    expect(db.state.partMakes).toHaveLength(0);
    expect(db.state.products[0].isUniversal).toBe(true);
  });
});

describe('numberLabels', () => {
  it('labels by which lists are populated, never by the number itself', () => {
    expect(numberLabels([], ['96611630'])).toEqual({
      partNumberType: 'OEM',
      isGm: false,
      isOem: true,
    });
    expect(numberLabels(['96611630'], [])).toEqual({
      partNumberType: 'GM',
      isGm: true,
      isOem: false,
    });
    expect(numberLabels(['96611630'], ['S4511006'])).toEqual({
      partNumberType: 'UNKNOWN',
      isGm: true,
      isOem: true,
    });
    expect(numberLabels([], [])).toEqual({
      partNumberType: 'UNKNOWN',
      isGm: false,
      isOem: false,
    });
  });
});
