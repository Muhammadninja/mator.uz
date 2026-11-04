// Unit tests for the inventory row presenter. The row is rendered in the admin
// console's stock table, so its category must travel with a name in every
// interface language: `name` is the INTERNAL canonical label (English for every
// seeded bucket) and showing it would label a Russian operator's table in
// English. Guards the localized names on the wire, the select that feeds them,
// and the derived stock status.

import { OilType, Prisma, ProductKind } from '@prisma/client';
import {
  ADMIN_INVENTORY_ROW_SELECT,
  deriveStockStatus,
  presentInventoryRow,
} from './admin-inventory.presenter';
import { FISCAL_CODES_UNCONFIRMED } from '../../common/fiscal.util';
import { confirmedCategory } from '../../../test/utils/harness';

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
    kind: ProductKind.SPARE_PART,
    oilType: null,
    packageForm: null,
    brand: { id: 'brand_1', name: 'Bosch' },
    category: {
      ...confirmedCategory({ id: 'brake-pads' }),
      name: 'Brake Pads',
      nameRu: 'Тормозные колодки',
      nameUz: 'Tormoz kolodkalari',
      nameEn: 'Brake Pads',
    },
    seller: { tin: '301234567', vatPercent: new Prisma.Decimal(0) },
    ...over,
  } as Parameters<typeof presentInventoryRow>[0];
}

// The row's verdict comes from the same rule Payme checkout runs, so the console can
// never call a part ready that checkout would refuse.
describe('presentInventoryRow — fiscal readiness', () => {
  it('is ready when the category is confirmed and the dealer has its tax data', () => {
    expect(presentInventoryRow(row()).fiscal).toEqual({
      ready: true,
      gaps: [],
    });
  });

  it('names what stops a part: an unconfirmed category and a dealer with no TIN', () => {
    const { fiscal } = presentInventoryRow(
      row({
        category: {
          ...row().category,
          fiscalConfirmedCodes: null,
        },
        seller: { tin: null, vatPercent: new Prisma.Decimal(0) },
      }),
    );
    expect(fiscal.ready).toBe(false);
    expect(fiscal.gaps).toEqual([FISCAL_CODES_UNCONFIRMED, 'dealer has no TIN']);
  });

  it('a spare part filed on a composition is refused, whatever its category says', () => {
    const { fiscal } = presentInventoryRow(
      row({
        category: {
          ...row().category,
          ...confirmedCategory({
            id: 'synthetic-motor-oil',
            parentId: 'motor-oil',
            mxik: null,
            packageCodeSingle: null,
            packageCodeSet: null,
          }),
        },
      }),
    );
    expect(fiscal.ready).toBe(false);
  });

  it('a motor oil on its own composition is ready', () => {
    const { fiscal } = presentInventoryRow(
      row({
        kind: ProductKind.MOTOR_OIL,
        oilType: OilType.SYNTHETIC,
        category: {
          ...row().category,
          ...confirmedCategory({
            id: 'synthetic-motor-oil',
            parentId: 'motor-oil',
            mxik: null,
            packageCodeSingle: null,
            packageCodeSet: null,
          }),
        },
      }),
    );
    expect(fiscal).toEqual({ ready: true, gaps: [] });
  });
});

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
