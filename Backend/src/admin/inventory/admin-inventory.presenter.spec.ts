// Unit tests for the inventory row presenter. The row is rendered in the admin
// console's stock table, so its category must travel with a name in every
// interface language: `name` is the INTERNAL canonical label (English for every
// seeded bucket) and showing it would label a Russian operator's table in
// English. Guards the localized names on the wire, the select that feeds them,
// and the derived stock status.

import { Prisma } from '@prisma/client';
import {
  ADMIN_INVENTORY_ROW_SELECT,
  deriveStockStatus,
  presentInventoryRow,
} from './admin-inventory.presenter';

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'part_1',
    title: 'Колодки тормозные передние',
    oemNumbers: ['96625873', '96626067'],
    gmNumbers: [],
    stockQty: 12,
    lowStockThreshold: 5,
    purchasePriceUzs: new Prisma.Decimal('120000'),
    priceUzs: new Prisma.Decimal('185000'),
    cashbackPct: new Prisma.Decimal('2.5'),
    brand: { id: 'brand_1', name: 'Bosch' },
    category: {
      id: 'brake-pads',
      name: 'Brake Pads',
      nameRu: 'Тормозные колодки',
      nameUz: 'Tormoz kolodkalari',
      nameEn: 'Brake Pads',
    },
    ...over,
  } as Parameters<typeof presentInventoryRow>[0];
}

describe('presentInventoryRow — localized category', () => {
  it('carries all three localized names so the console can label the row', () => {
    const out = presentInventoryRow(row());

    expect(out.category).toEqual({
      id: 'brake-pads',
      name: 'Brake Pads',
      nameRu: 'Тормозные колодки',
      nameUz: 'Tormoz kolodkalari',
      nameEn: 'Brake Pads',
    });
  });

  it.each([
    ['ru', 'nameRu', 'Тормозные колодки'],
    ['uz', 'nameUz', 'Tormoz kolodkalari'],
    ['en', 'nameEn', 'Brake Pads'],
  ])(
    'gives a %s console the label from %s',
    (_lang, field, expected) => {
      const category = presentInventoryRow(row()).category as Record<
        string,
        string
      >;
      expect(category[field]).toBe(expected);
    },
  );

  it('keeps the internal `name` on the wire for backwards compatibility', () => {
    // Kept deliberately — removing it would break clients reading it today.
    // It is documented as non-displayable, not deleted.
    expect(presentInventoryRow(row()).category.name).toBe('Brake Pads');
  });

  it('selects the localized names, so they are never missing at runtime', () => {
    // The presenter can only emit what the select reads: guarding the select
    // is what stops a "category.nameRu is undefined" regression on the wire.
    expect(ADMIN_INVENTORY_ROW_SELECT.category.select).toMatchObject({
      id: true,
      name: true,
      nameRu: true,
      nameUz: true,
      nameEn: true,
    });
  });
});

describe('deriveStockStatus', () => {
  it.each([
    [0, 5, 'out_of_stock'],
    [-1, 5, 'out_of_stock'],
    [3, 5, 'low_stock'],
    [5, 5, 'in_stock'],
    [12, 5, 'in_stock'],
  ])('qty %i against threshold %i is %s', (qty, threshold, expected) => {
    expect(deriveStockStatus(qty, threshold)).toBe(expected);
  });
});
