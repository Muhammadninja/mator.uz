import {
  canonicalIdentityKey,
  canonicalIdentityTuple,
  IMAGE_REVIEW_REASONS,
  planVehicleIdentity,
  validateCanonicalIdentity,
  type VehicleIdentitySource,
} from './vehicle-image.identity';

/**
 * Golden vectors produced by the REAL pipeline code, MatorUI-
 * services/vehicle-image-pipeline.mjs @ 567bdfc0ae89ead383f23b6a0731b1de09e61f08,
 * `canonicalVehicleIdentityKey(identity)`. If one of these fails, the port has
 * drifted from the pipeline and deduplication would silently break.
 */
const GOLDEN = [
  {
    identity: {
      makeId: 'byd',
      modelId: 'byd-han',
      modelYear: 2024,
      generationId: null,
      faceliftId: null,
      bodyType: null,
      trimId: null,
    },
    key: 'c35f59f25a1783cef099ae687bd3b067e2e7d3429679d27b508a3eb08ba36cdb',
  },
  {
    identity: {
      makeId: 'chevrolet',
      modelId: 'cobalt',
      modelYear: 2022,
      generationId: null,
      faceliftId: null,
      bodyType: 'sedan',
      trimId: 'cobalt-p4-ltz',
    },
    key: '43c116d7c2187bd37fee4f14f764c00e4e8b098bd791aa4e817199a9abed5f0f',
  },
  {
    identity: {
      makeId: ' chevrolet ',
      modelId: 'nexia',
      modelYear: 2016,
      generationId: null,
      faceliftId: null,
      bodyType: '  Sedan  ',
      trimId: null,
    },
    key: '92eaf9ad899a7215d481421f30b1a7bde79513383048da22587805a91b6f5043',
  },
  {
    identity: {
      makeId: 'chevrolet',
      modelId: 'genrta-lacetti',
      modelYear: 2015,
      generationId: null,
      faceliftId: null,
      bodyType: 'хэтчбек',
      trimId: null,
    },
    key: 'ee4397b81acdaeb00282ffb9373b1074c51b13e2c2cce29a3be02042a477a6ad',
  },
];

describe('canonical vehicle identity (Phase 3D contract)', () => {
  it.each(GOLDEN)(
    'matches the pipeline key for $identity.modelId',
    ({ identity, key }) => {
      expect(canonicalIdentityKey(identity)).toBe(key);
    },
  );

  it('builds the exact ordered, versioned tuple', () => {
    expect(canonicalIdentityTuple(GOLDEN[2].identity)).toEqual([
      'mator-vehicle-image-v1',
      'chevrolet',
      'nexia',
      2016,
      null,
      null,
      'Sedan',
      null,
    ]);
  });

  it('rejects what the pipeline rejects', () => {
    const base = GOLDEN[0].identity;
    expect(() => validateCanonicalIdentity({ ...base, vin: 'x' })).toThrow(
      /unsupported/,
    );
    expect(() =>
      validateCanonicalIdentity({ ...base, modelId: 'bad id' }),
    ).toThrow(/canonical catalog ID/);
    expect(() => validateCanonicalIdentity({ ...base, bodyType: '' })).toThrow(
      /bodyType is invalid/,
    );
    expect(() =>
      validateCanonicalIdentity({ ...base, trimId: undefined }),
    ).toThrow(/trimId must be text/);
    expect(() =>
      validateCanonicalIdentity({ ...base, modelYear: 2024.5 }),
    ).toThrow(/modelYear/);
    const missing: Record<string, unknown> = { ...base };
    delete missing.trimId;
    expect(() => validateCanonicalIdentity(missing)).toThrow(
      /every ordered identity field/,
    );
  });
});

describe('planVehicleIdentity', () => {
  const src = (
    over: Partial<VehicleIdentitySource> = {},
  ): VehicleIdentitySource => ({
    year: 2022,
    make: { id: 'chevrolet', name: 'Chevrolet' },
    model: {
      id: 'cobalt',
      makeId: 'chevrolet',
      name: 'Cobalt',
      bodyType: null,
      yearFrom: null,
      yearTo: null,
    },
    trim: null,
    siblingModelNames: ['Nexia', 'Malibu'],
    ...over,
  });

  it('uses only make, model and year when nothing else is authoritative', () => {
    const plan = planVehicleIdentity(src());
    expect(plan).toEqual({
      kind: 'request',
      identity: {
        makeId: 'chevrolet',
        modelId: 'cobalt',
        modelYear: 2022,
        generationId: null,
        faceliftId: null,
        bodyType: null,
        trimId: null,
      },
      display: { manufacturer: 'Chevrolet', model: 'Cobalt' },
      identityKey: canonicalIdentityKey({
        makeId: 'chevrolet',
        modelId: 'cobalt',
        modelYear: 2022,
        generationId: null,
        faceliftId: null,
        bodyType: null,
        trimId: null,
      }),
    });
  });

  it('adds the catalog body type and the picked trim, never a generation or facelift', () => {
    const plan = planVehicleIdentity(
      src({
        model: {
          id: 'cobalt',
          makeId: 'chevrolet',
          name: 'Cobalt',
          bodyType: 'sedan',
          yearFrom: 2011,
          yearTo: null,
        },
        trim: { id: 'cobalt-p4-ltz', modelId: 'cobalt', name: 'LTZ' },
      }),
    );
    expect(plan.kind).toBe('request');
    if (plan.kind !== 'request') return;
    expect(plan.identity).toEqual({
      makeId: 'chevrolet',
      modelId: 'cobalt',
      modelYear: 2022,
      generationId: null,
      faceliftId: null,
      bodyType: 'sedan',
      trimId: 'cobalt-p4-ltz',
    });
    expect(plan.display).toEqual({
      manufacturer: 'Chevrolet',
      model: 'Cobalt',
      trim: 'LTZ',
    });
    expect(plan.identityKey).toBe(GOLDEN[1].key);
  });

  it('treats a blank catalog body type as absent', () => {
    const plan = planVehicleIdentity(
      src({
        model: {
          id: 'cobalt',
          makeId: 'chevrolet',
          name: 'Cobalt',
          bodyType: '  ',
          yearFrom: null,
          yearTo: null,
        },
      }),
    );
    expect(plan.kind === 'request' && plan.identity.bodyType).toBeNull();
  });

  it('includes an explicitly configured market in identity and display without inferring it', () => {
    const legacy = planVehicleIdentity(src());
    const marketAware = planVehicleIdentity(src({ marketRegion: 'UZ' }));
    expect(legacy.kind === 'request' && legacy.identity.marketRegion).toBeUndefined();
    expect(marketAware).toMatchObject({
      kind: 'request',
      identity: { modelId: 'cobalt', marketRegion: 'UZ' },
      display: { manufacturer: 'Chevrolet', model: 'Cobalt', marketRegion: 'UZ' },
    });
    if (legacy.kind === 'request' && marketAware.kind === 'request')
      expect(marketAware.identityKey).not.toBe(legacy.identityKey);
    expect(() => validateCanonicalIdentity({
      ...GOLDEN[0].identity,
      marketRegion: 'uz',
    })).toThrow(/marketRegion/);
  });

  it('flags a model whose name another model of the make shares (tracker / tracker-2)', () => {
    const plan = planVehicleIdentity(
      src({
        model: {
          id: 'tracker-2',
          makeId: 'chevrolet',
          name: 'Tracker',
          bodyType: null,
          yearFrom: null,
          yearTo: null,
        },
        siblingModelNames: ['  tracker '],
      }),
    );
    expect(plan).toEqual({
      kind: 'review',
      reason: IMAGE_REVIEW_REASONS.DUPLICATE_MODEL_NAME,
    });
  });

  it('flags a year outside the catalog production range', () => {
    const model = {
      id: 'cobalt',
      makeId: 'chevrolet',
      name: 'Cobalt',
      bodyType: null,
      yearFrom: 2011,
      yearTo: 2020,
    };
    expect(planVehicleIdentity(src({ model, year: 2010 }))).toEqual({
      kind: 'review',
      reason: 'year_outside_model_range',
    });
    expect(planVehicleIdentity(src({ model, year: 2021 }))).toEqual({
      kind: 'review',
      reason: 'year_outside_model_range',
    });
    expect(planVehicleIdentity(src({ model, year: 2020 })).kind).toBe(
      'request',
    );
  });

  it('flags catalog rows that cannot form a canonical identity', () => {
    expect(planVehicleIdentity(src({ make: null })).kind).toBe('review');
    expect(
      planVehicleIdentity(
        src({
          model: {
            id: 'bad id',
            makeId: 'chevrolet',
            name: 'X',
            bodyType: null,
            yearFrom: null,
            yearTo: null,
          },
        }),
      ),
    ).toEqual({ kind: 'review', reason: 'identity_invalid' });
    expect(
      planVehicleIdentity(src({ make: { id: 'chevrolet', name: '   ' } })).kind,
    ).toBe('review');
    expect(
      planVehicleIdentity(
        src({ trim: { id: 'x', modelId: 'other', name: 'LS' } }),
      ).kind,
    ).toBe('review');
  });
});
