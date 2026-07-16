// Unit tests for the part presenter's `fits[]` output (Phase 4E). The static
// make/model fitment already lives in catalog_part_fits (projected from the
// supply-side PartModel links); Phase 4E only surfaces it. These tests pin the
// contract: correct field mapping, deterministic order, and an empty array for
// parts with no fit rows (universal parts). No schema change, no invented data.

import { presentPartItem, PartWithRelations } from './part.presenter';

function fit(over: Partial<PartWithRelations['fits'][number]> = {}): PartWithRelations['fits'][number] {
  return {
    partId: 'part-1',
    makeSlug: 'make_chevrolet',
    modelSlug: 'model_chevrolet_cobalt',
    makeName: 'Chevrolet',
    modelName: 'Cobalt',
    ...over,
  } as PartWithRelations['fits'][number];
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
    stockQty: 3,
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
    createdAt: new Date() as never,
    updatedAt: new Date() as never,
    brand: null,
    category: { id: 'cat-1', name: 'Filters' } as never,
    seller: { id: 'seller-1', name: 'AutoPro', ratingAvg: 0 } as never,
    compatibilities: [],
    fits: [],
    ...over,
  } as PartWithRelations;
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
