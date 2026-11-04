import {
  FakeDb,
  driversVillageFixture,
} from '../../../test/utils/drivers-village-fake-db';
import { numberLabels, writePosition } from './drivers-village.store';
import type { PositionWrite, StockSync } from './drivers-village.types';

function create(over: Partial<PositionWrite> = {}): PositionWrite {
  return {
    kind: 'create',
    code1c: 'БП-01071006',
    priceUzs: '2031708.59',
    quantity: 2,
    unit: 'PCS',
    product: {
      title: 'Стартер',
      gmNumbers: [],
      sourcePartNumber: '13520817',
      oemNumbers: ['13520817'],
    },
    models: [
      { make: 'Chevrolet', model: 'Malibu' },
      { make: 'Chevrolet', model: 'Tracker' },
    ],
    makes: [],
    ...over,
  };
}

const sync = (stockId: number, over: Partial<StockSync> = {}): StockSync => ({
  kind: 'sync',
  code1c: 'БП-01071006',
  stockId,
  priceUzs: null,
  quantity: null,
  ...over,
});

describe('writePosition — initial creation (Prisma write contract)', () => {
  it('keys the stock on (seller, DRIVERS_VILLAGE_1C, code_1c) and creates product + stock once', async () => {
    const db = new FakeDb(driversVillageFixture());
    const first = await writePosition(db.tx, 7, create());

    expect(first.created).toBe(true);
    expect(db.state.stocks).toEqual([
      expect.objectContaining({
        sellerId: 7,
        sourceSystem: 'DRIVERS_VILLAGE_1C',
        sourceCode: 'БП-01071006',
        priceUzs: '2031708.59',
        quantity: 2,
        unit: 'PCS',
      }),
    ]);
    // A second creation of the same code (one that appeared after planning)
    // is refused — so its batch rolls back — and touches nothing.
    await expect(
      writePosition(db.tx, 7, create({ priceUzs: '1.00' })),
    ).rejects.toThrow(/already has a position/);
    expect(db.state.stocks).toHaveLength(1);
    expect(db.state.stocks[0].priceUzs).toBe('2031708.59');
    expect(db.state.products).toHaveLength(1);
  });

  it('a quantity the file does not give is never written: the column default applies', async () => {
    const db = new FakeDb(driversVillageFixture());
    await writePosition(db.tx, 7, create({ quantity: null }));
    expect(db.state.stocks[0].quantity).toBe(1); // DEFAULT 1, not set by code
  });

  it('writes the source part number verbatim', async () => {
    const db = new FakeDb(driversVillageFixture());
    const raw = 'SCT SB 061-0868';
    await writePosition(
      db.tx,
      7,
      create({
        code1c: raw,
        product: { ...create().product, sourcePartNumber: raw },
      }),
    );
    expect(db.state.products[0].sourcePartNumber).toBe(raw);
    expect(db.state.stocks[0].sourceCode).toBe(raw);
  });

  it('writes fitment once — models and make-wide makes — and never marks a part universal', async () => {
    const db = new FakeDb(driversVillageFixture());
    await writePosition(
      db.tx,
      7,
      create({
        makes: ['Chevrolet'],
        models: [
          { make: 'Chevrolet', model: 'Damas' },
          { make: 'Chevrolet', model: 'Labo' },
        ],
      }),
    );
    expect(db.state.partModels).toHaveLength(2);
    expect(db.state.partMakes).toHaveLength(1);
    expect(db.state.products[0].isUniversal).toBe(false);
    expect(db.calls).not.toContain('partModel.deleteMany');
    expect(db.calls).not.toContain('partMake.deleteMany');

    const db2 = new FakeDb(driversVillageFixture());
    await writePosition(db2.tx, 7, create({ models: [], makes: [] }));
    expect(db2.state.partModels).toHaveLength(0);
    expect(db2.state.products[0].isUniversal).toBe(false);
  });

  it('never writes a category, photos, image_url, description, rating or the Telegram GM key', async () => {
    const db = new FakeDb(driversVillageFixture());
    await writePosition(db.tx, 7, create());
    expect(db.calls.some((c) => c.startsWith('productImage'))).toBe(false);
    expect(db.state.products[0]).toMatchObject({
      gmNumber: null,
      imageUrl: null,
      description: null,
      categoryId: null,
      vehicleCategoryId: null,
      mainCategory: null,
      vehicleCategory: null,
    });
  });
});

describe('writePosition — synchronization of a stored position', () => {
  async function stored() {
    const db = new FakeDb(driversVillageFixture());
    const { stockId, productId } = await writePosition(db.tx, 7, create());
    // What Mator owns once the position exists.
    const card = {
      title: 'Стартер (Mator)',
      imageUrl: 'https://img/a.jpg',
      description: 'manual',
      ratingAvg: '4.5',
      reviewCount: 3,
      categoryId: 'starters',
      vehicleCategoryId: 'electrical-and-lighting',
      mainCategory: 'ELECTRICAL_PARTS',
      vehicleCategory: 'ELECTRICAL_AND_LIGHTING',
    };
    Object.assign(db.state.products[0], card);
    db.state.productImages.push({ productId, url: 'https://img/a.jpg' });
    db.calls.length = 0;
    return { db, stockId, productId, card };
  }

  it('writes only stocks.price_uzs and a stated quantity — nothing of the product, its links or the unit', async () => {
    const { db, stockId, card } = await stored();
    const links = JSON.stringify([db.state.partModels, db.state.partMakes]);

    const out = await writePosition(
      db.tx,
      7,
      sync(stockId, { priceUzs: '1.00' }),
    );
    expect(out).toMatchObject({ stockId, created: false });
    expect(db.state.stocks[0]).toMatchObject({
      priceUzs: '1',
      quantity: 2, // not stated: kept
      unit: 'PCS',
    });

    await writePosition(db.tx, 7, sync(stockId, { quantity: 0 }));
    expect(db.state.stocks[0]).toMatchObject({ priceUzs: '1', quantity: 0 });

    expect(db.calls).toEqual([
      'stock.findUnique',
      'stock.update',
      'stock.findUnique',
      'stock.update',
    ]);
    expect(db.state.products[0]).toMatchObject(card);
    expect(db.state.productImages).toHaveLength(1);
    expect(JSON.stringify([db.state.partModels, db.state.partMakes])).toBe(
      links,
    );
  });

  it('finds its stock again by the exact key: a stale plan fails (its batch rolls back) instead of writing another position', async () => {
    const { db, stockId } = await stored();
    await writePosition(db.tx, 7, create({ code1c: 'OTHER-1' }));
    // Planned for another stock id, or for a code whose position is gone.
    await expect(
      writePosition(db.tx, 7, sync(stockId + 1, { priceUzs: '5.00' })),
    ).rejects.toThrow(/changed after planning/);
    await expect(
      writePosition(
        db.tx,
        7,
        sync(stockId, { code1c: 'GONE-1', priceUzs: '5.00' }),
      ),
    ).rejects.toThrow(/changed after planning/);
    // Another seller's identical code is never this seller's position.
    await expect(
      writePosition(db.tx, 8, sync(stockId, { priceUzs: '5.00' })),
    ).rejects.toThrow(/changed after planning/);
    expect(db.state.stocks.map((s) => s.priceUzs)).toEqual([
      '2031708.59',
      '2031708.59',
    ]);
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
