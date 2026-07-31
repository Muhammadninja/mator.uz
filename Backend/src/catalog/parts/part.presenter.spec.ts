// Unit tests for the part presenter's `fits[]` output (Phase 4E). The static
// make/model fitment already lives in catalog_part_fits (projected from the
// supply-side PartModel links); Phase 4E only surfaces it. These tests pin the
// contract: correct field mapping, deterministic order, and an empty array for
// parts with no fit rows (universal parts). No schema change, no invented data.

import { presentPartItem, PartWithRelations } from './part.presenter';

function fit(
  over: Partial<PartWithRelations['fits'][number]> = {},
): PartWithRelations['fits'][number] {
  return {
    partId: 'part-1',
    makeSlug: 'make_chevrolet',
    modelSlug: 'model_chevrolet_cobalt',
    makeName: 'Chevrolet',
    modelName: 'Cobalt',
    ...over,
  };
}

function part(over: Partial<PartWithRelations> = {}): PartWithRelations {
  return {
    id: 'part-1',
    title: 'Oil filter',
    brandId: null,
    categoryId: 'cat-1',
    sellerId: 'seller-1',
    oemNumbers: [],
    gmNumbers: [],
    partNumberType: 'UNKNOWN',
    priceUzs: 25000 as never,
    currency: 'UZS',
    condition: 'NEW',
    inStock: true,
    deliveryEtaDaysMin: null,
    deliveryEtaDaysMax: null,
    images: [],
    mainCategory: null,
    vehicleCategory: null,
    partBrandName: null,
    originRegion: null,
    isOem: false,
    isGm: false,
    isUniversal: false,
    kind: 'SPARE_PART',
    oilViscosity: null,
    oilType: null,
    oilVolumeMl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    brand: null,
    category: { id: 'cat-1', name: 'Filters' } as never,
    seller: {
      id: 'seller-1',
      name: 'AutoPro',
      ratingAvg: 0,
      certified: false,
    } as never,
    compatibilities: [],
    fits: [],
    ...over,
  };
}

describe('presentPartItem — fits[]', () => {
  it('maps each fit row to the snake_case contract shape', () => {
    const out = presentPartItem(part({ fits: [fit()] }), null);
    expect(out.fits).toEqual([
      {
        make_slug: 'make_chevrolet',
        make_name: 'Chevrolet',
        model_slug: 'model_chevrolet_cobalt',
        model_name: 'Cobalt',
      },
    ]);
  });

  it('sorts fits deterministically by model slug regardless of input order', () => {
    const out = presentPartItem(
      part({
        fits: [
          fit({ modelSlug: 'model_chevrolet_tracker', modelName: 'Tracker' }),
          fit({ modelSlug: 'model_chevrolet_cobalt', modelName: 'Cobalt' }),
          fit({ modelSlug: 'model_chevrolet_lacetti', modelName: 'Lacetti' }),
        ],
      }),
      null,
    );
    expect(out.fits.map((f) => f.model_slug)).toEqual([
      'model_chevrolet_cobalt',
      'model_chevrolet_lacetti',
      'model_chevrolet_tracker',
    ]);
  });

  it('returns an empty fits array for a part with no fit rows (universal)', () => {
    const out = presentPartItem(part({ isUniversal: true, fits: [] }), null);
    expect(out.fits).toEqual([]);
  });

  it('does not mutate the input fits array when sorting', () => {
    const fits = [
      fit({ modelSlug: 'model_chevrolet_tracker' }),
      fit({ modelSlug: 'model_chevrolet_cobalt' }),
    ];
    presentPartItem(part({ fits }), null);
    expect(fits.map((f) => f.modelSlug)).toEqual([
      'model_chevrolet_tracker',
      'model_chevrolet_cobalt',
    ]);
  });
});

describe('presentPartItem — seller', () => {
  it('exposes the certified badge alongside id/name/rating_avg', () => {
    const out = presentPartItem(
      part({
        seller: {
          id: 'seller-1',
          name: 'AutoPro',
          ratingAvg: 4.5,
          certified: true,
        } as never,
      }),
      null,
    );
    expect(out.seller).toEqual({
      id: 'seller-1',
      name: 'AutoPro',
      rating_avg: 4.5,
      certified: true,
    });
  });

  it('reports certified:false for an uncertified seller, never null', () => {
    const out = presentPartItem(part(), null);
    expect(out.seller.certified).toBe(false);
  });
});

describe('presentPartItem — kind attributes', () => {
  it('exposes a motor oil’s attributes with raw values AND display labels', () => {
    const out = presentPartItem(
      part({
        kind: 'MOTOR_OIL',
        title: 'Mobil 1 ESP 5W-30 4L',
        oilViscosity: '5W-30',
        oilType: 'SYNTHETIC',
        oilVolumeMl: 4000,
      } as never),
      null,
    );
    expect(out.kind).toBe('MOTOR_OIL');
    expect(out.motor_oil).toEqual({
      viscosity: '5W-30',
      oil_type: 'SYNTHETIC',
      oil_type_label: 'Синтетическое',
      volume_ml: 4000,
      volume_label: '4 л',
    });
  });

  it('formats a non-preset volume from millilitres', () => {
    const out = presentPartItem(
      part({
        kind: 'MOTOR_OIL',
        oilViscosity: '0W-16',
        oilType: 'MINERAL',
        oilVolumeMl: 3500,
      } as never),
      null,
    );
    expect(out.motor_oil?.volume_label).toBe('3.5 л');
  });

  it('reports no kind attributes for a spare part (the default kind)', () => {
    const out = presentPartItem(part(), null);
    expect(out.kind).toBe('SPARE_PART');
    expect(out.motor_oil).toBeNull();
  });

  it('keeps every spare-part field unchanged when the kind is added', () => {
    // Regression: the kind fields are ADDITIVE — nothing existing moved or was
    // renamed by them.
    const out = presentPartItem(part(), null);
    expect(out).toMatchObject({
      id: 'part-1',
      title: 'Oil filter',
      price_uzs: 25000,
      in_stock: true,
      is_universal: false,
      part_number_type: 'UNKNOWN',
    });
  });
});

describe('presentPartItem — a motor oil card hides spare-part concepts', () => {
  const oil = () =>
    part({
      kind: 'MOTOR_OIL',
      title: 'Mobil 1 ESP 5W-30 4L',
      oilViscosity: '5W-30',
      oilType: 'SYNTHETIC',
      oilVolumeMl: 4000,
      isUniversal: true,
    } as never);

  it('reports NO part-number type (never a misleading "UNKNOWN")', () => {
    // "UNKNOWN" would read as "this oil's number is unlabeled", inviting a UI to
    // render an empty OEM/GM row for a product that can never have one.
    const out = presentPartItem(oil(), null);
    expect(out.part_number_type).toBeNull();
    expect(out.oem_numbers).toEqual([]);
    expect(out.gm_numbers).toEqual([]);
    expect(out.is_oem).toBe(false);
    expect(out.is_gm).toBe(false);
  });

  it('reports NO compatibility, even with a garage vehicle selected', () => {
    // The generic path would answer {status:'maybe'} — actively wrong, since an
    // oil fits every car.
    const out = presentPartItem(oil(), {
      trimId: 'trim_1',
      engineId: null,
      year: 2020,
    });
    expect(out.compatibility).toBeNull();
  });

  it('carries no vehicle fitment rows', () => {
    expect(presentPartItem(oil(), null).fits).toEqual([]);
  });

  it('still exposes the oil’s own attributes and the shared fields', () => {
    const out = presentPartItem(oil(), null);
    expect(out.motor_oil).toMatchObject({
      viscosity: '5W-30',
      oil_type_label: 'Синтетическое',
      volume_label: '4 л',
    });
    expect(out.title).toBe('Mobil 1 ESP 5W-30 4L');
    expect(out.price_uzs).toBe(25000);
    expect(out.is_universal).toBe(true);
  });

  it('a SPARE PART keeps its part number and compatibility (regression)', () => {
    const out = presentPartItem(
      part({ partNumberType: 'OEM', oemNumbers: ['96535062'] } as never),
      { trimId: 'trim_1', engineId: null, year: 2020 },
    );
    expect(out.part_number_type).toBe('OEM');
    expect(out.oem_numbers).toEqual(['96535062']);
    // No compatibility rows → "maybe", the long-standing behaviour for parts.
    expect(out.compatibility).toEqual({
      status: 'maybe',
      confidence: 0,
      notes: null,
    });
  });
});

describe('presentPartItem — sale pricing', () => {
  it('leaves the price untouched and sale null when no discount is passed', () => {
    const out = presentPartItem(part(), null);
    expect(out.price_uzs).toBe(25000);
    expect(out.price_label).toBe('UZS 25 000');
    expect(out.original_price_uzs).toBeNull();
    expect(out.sale).toBeNull();
  });

  it('surfaces the discounted price, original, and sale block when a sale applies', () => {
    const discount = {
      originalPrice: 25000,
      finalPrice: 21250,
      discountAmount: 3750,
      discountPercent: 15,
      appliedSale: {
        id: 'sale_1',
        title: 'Filters 15%',
        discountType: 'PERCENT',
        discountValue: 15,
      },
    };
    const out = presentPartItem(part(), null, discount as never);
    // price_uzs is the CHARGED price (what the cart bills), not the original.
    expect(out.price_uzs).toBe(21250);
    expect(out.price_label).toBe('UZS 21 250');
    expect(out.original_price_uzs).toBe(25000);
    expect(out.original_price_label).toBe('UZS 25 000');
    expect(out.sale).toEqual({
      id: 'sale_1',
      title: 'Filters 15%',
      discount_type: 'PERCENT',
      discount_value: 15,
      discount_percent: 15,
      discount_amount_uzs: 3750,
    });
  });

  it('ignores a discount result that applied no sale', () => {
    const noSale = {
      originalPrice: 25000,
      finalPrice: 25000,
      discountAmount: 0,
      discountPercent: 0,
      appliedSale: null,
    };
    const out = presentPartItem(part(), null, noSale as never);
    expect(out.price_uzs).toBe(25000);
    expect(out.original_price_uzs).toBeNull();
    expect(out.sale).toBeNull();
  });
});
