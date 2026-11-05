// Delivery configuration, as the application boots with it (src/env.validation.ts).

import { validateEnv } from '../env.validation';
import { isWithinCoverage } from './delivery-coverage';
import {
  collectDeliveryConfigErrors,
  readDeliveryCoverage,
  readDeliveryRates,
} from './delivery.config';
import { DEFAULT_DELIVERY_RATES, tariffVersionOf } from './delivery-pricing';

const PROD = {
  NODE_ENV: 'production',
  PAYME_MERCHANT_ID: 'merchant-1',
  PAYME_MERCHANT_KEY: 'merchant-secret',
  UZMAPS_API_KEY: 'uzmaps-key',
};

const AREA = JSON.stringify({
  type: 'Polygon',
  coordinates: [
    [
      [10, 10],
      [20, 10],
      [20, 20],
      [10, 20],
      [10, 10],
    ],
  ],
});

describe('booting without a delivery area', () => {
  it('is valid, with or without a key: couriers are off and pickup carries on', () => {
    expect(() =>
      validateEnv({ ...PROD, UZMAPS_API_KEY: undefined }),
    ).not.toThrow();
    expect(() => validateEnv(PROD)).not.toThrow();
  });

  it.each([undefined, '', '   '])('%p counts as no area', (raw) => {
    expect(
      readDeliveryCoverage((key) =>
        key === 'DELIVERY_COVERAGE_POLYGON' ? raw : undefined,
      ),
    ).toBeNull();
  });

  it('assumes no area from anything else in the environment', () => {
    expect(
      readDeliveryCoverage(
        (key) =>
          ({
            UZMAPS_API_KEY: 'k',
            DELIVERY_COVERAGE_BBOX: '55.9,37.1,73.2,45.7',
          })[key],
      ),
    ).toBeNull();
  });
});

describe('UZMAPS_API_KEY at boot, once there is an area', () => {
  const WITH_AREA = { ...PROD, DELIVERY_COVERAGE_POLYGON: AREA };

  it('a production env holding it boots', () => {
    expect(() => validateEnv(WITH_AREA)).not.toThrow();
  });

  it.each([
    ['missing', undefined],
    ['empty, as .env.example leaves it', ''],
    ['blank', '   '],
  ])('production refuses to boot with the key %s', (_, UZMAPS_API_KEY) => {
    expect(() => validateEnv({ ...WITH_AREA, UZMAPS_API_KEY })).toThrow(
      /UZMAPS_API_KEY is required in production/,
    );
  });

  it.each(['development', 'test', undefined])(
    'NODE_ENV=%s boots without it, so tests and local work need no key',
    (NODE_ENV) => {
      expect(
        collectDeliveryConfigErrors({
          NODE_ENV,
          DELIVERY_COVERAGE_POLYGON: AREA,
        }),
      ).toEqual([]);
    },
  );
});

describe('delivery rates', () => {
  const read = (env: Record<string, string>) =>
    readDeliveryRates((key) => env[key]);

  it('default to the published rules when unset or blank', () => {
    expect(read({})).toEqual(DEFAULT_DELIVERY_RATES);
    expect(
      read({ DELIVERY_TIER_PRICES_UZS: ' ', DELIVERY_EXTRA_KM_PRICE_UZS: '' }),
    ).toEqual(DEFAULT_DELIVERY_RATES);
  });

  it('can be changed from the environment, each on its own', () => {
    expect(read({ DELIVERY_TIER_PRICES_UZS: '6000, 8000 ,10000' })).toEqual({
      tierPricesUzs: [6_000, 8_000, 10_000],
      extraKmPriceUzs: DEFAULT_DELIVERY_RATES.extraKmPriceUzs,
    });
    expect(read({ DELIVERY_EXTRA_KM_PRICE_UZS: '3000' })).toEqual({
      tierPricesUzs: DEFAULT_DELIVERY_RATES.tierPricesUzs,
      extraKmPriceUzs: 3_000,
    });
  });

  it('allow a flat stretch: the next kilometre may cost the same', () => {
    expect(
      collectDeliveryConfigErrors({
        DELIVERY_TIER_PRICES_UZS: '5000,5000,7000',
      }),
    ).toEqual([]);
  });

  it.each([
    ['text', 'cheap'],
    ['a gap in the list', '5000,,7000'],
    ['a zero', '0,7000'],
    ['a negative', '-5000,7000'],
    ['a fraction', '5000.5,7000'],
    ['a price too large to be exact', '99999999999999999999'],
  ])('refuse a tier list holding %s', (_, DELIVERY_TIER_PRICES_UZS) => {
    expect(() =>
      validateEnv({ NODE_ENV: 'test', DELIVERY_TIER_PRICES_UZS }),
    ).toThrow(/DELIVERY_TIER_PRICES_UZS must be a comma-separated list/);
  });

  it('refuse a list that gets cheaper with distance', () => {
    expect(() =>
      validateEnv({ NODE_ENV: 'test', DELIVERY_TIER_PRICES_UZS: '7000,5000' }),
    ).toThrow(/must not get cheaper/);
  });

  it.each(['x', '0', '-1', '2.5'])(
    'refuse an extra-kilometre price of %p',
    (DELIVERY_EXTRA_KM_PRICE_UZS) => {
      expect(() =>
        validateEnv({ NODE_ENV: 'test', DELIVERY_EXTRA_KM_PRICE_UZS }),
      ).toThrow(/DELIVERY_EXTRA_KM_PRICE_UZS must be a positive whole/);
    },
  );
});

describe('the tariff version', () => {
  it('is the same for the same rates, so it needs no bumping', () => {
    expect(tariffVersionOf(DEFAULT_DELIVERY_RATES)).toBe(
      tariffVersionOf({
        tierPricesUzs: [...DEFAULT_DELIVERY_RATES.tierPricesUzs],
        extraKmPriceUzs: DEFAULT_DELIVERY_RATES.extraKmPriceUzs,
      }),
    );
  });

  it.each([
    ['another tier', { ...DEFAULT_DELIVERY_RATES, tierPricesUzs: [6_000] }],
    [
      'another extra kilometre',
      { ...DEFAULT_DELIVERY_RATES, extraKmPriceUzs: 2_501 },
    ],
  ])('differs with %s', (_, rates) => {
    expect(tariffVersionOf(rates)).not.toBe(
      tariffVersionOf(DEFAULT_DELIVERY_RATES),
    );
  });
});

describe('the delivery area', () => {
  const read = (raw: string) =>
    readDeliveryCoverage((key) =>
      key === 'DELIVERY_COVERAGE_POLYGON' ? raw : undefined,
    );
  const square = (min: number, max: number) => [
    [min, min],
    [max, min],
    [max, max],
    [min, max],
    [min, min],
  ];

  describe('a polygon', () => {
    const area = read(AREA)!;

    it('takes in what is inside it, and works out the box around it', () => {
      expect(isWithinCoverage({ lng: 15, lat: 15 }, area)).toBe(true);
      expect(area.bounds).toEqual({
        minLng: 10,
        minLat: 10,
        maxLng: 20,
        maxLat: 20,
      });
    });

    it.each([
      ['beyond the box', 25, 15],
      ['on the other side', 5, 15],
      ['0,0', 0, 0],
    ])('leaves out %s', (_, lng, lat) => {
      expect(isWithinCoverage({ lng, lat }, area)).toBe(false);
    });

    it.each([
      ['a corner', 10, 10],
      ['a side', 15, 10],
      ['the far side', 20, 15],
    ])('counts %s of the boundary as inside', (_, lng, lat) => {
      expect(isWithinCoverage({ lng, lat }, area)).toBe(true);
    });

    it('reads [longitude, latitude], not the other way round', () => {
      const wide = read(
        JSON.stringify({
          type: 'Polygon',
          coordinates: [
            [
              [69, 41],
              [70, 41],
              [70, 42],
              [69, 42],
              [69, 41],
            ],
          ],
        }),
      )!;
      expect(isWithinCoverage({ lng: 69.5, lat: 41.5 }, wide)).toBe(true);
      expect(isWithinCoverage({ lng: 41.5, lat: 69.5 }, wide)).toBe(false);
    });
  });

  it('goes by the shape: a corner of the box outside the shape is outside', () => {
    const triangle = read(
      JSON.stringify({
        type: 'Polygon',
        coordinates: [
          [
            [10, 10],
            [20, 10],
            [10, 20],
            [10, 10],
          ],
        ],
      }),
    )!;
    expect(isWithinCoverage({ lng: 12, lat: 12 }, triangle)).toBe(true);
    expect(isWithinCoverage({ lng: 19, lat: 19 }, triangle)).toBe(false);
  });

  it('leaves out a hole, while its edge still counts as covered', () => {
    const area = read(
      JSON.stringify({
        type: 'Polygon',
        coordinates: [square(10, 20), square(14, 16)],
      }),
    )!;
    expect(isWithinCoverage({ lng: 15, lat: 15 }, area)).toBe(false);
    expect(isWithinCoverage({ lng: 14, lat: 15 }, area)).toBe(true);
    expect(isWithinCoverage({ lng: 12, lat: 12 }, area)).toBe(true);
  });

  it('takes separate areas as a MultiPolygon, and nothing between them', () => {
    const areas = read(
      JSON.stringify({
        type: 'MultiPolygon',
        coordinates: [[square(10, 20)], [square(30, 40)]],
      }),
    )!;
    expect(isWithinCoverage({ lng: 15, lat: 15 }, areas)).toBe(true);
    expect(isWithinCoverage({ lng: 35, lat: 35 }, areas)).toBe(true);
    expect(isWithinCoverage({ lng: 25, lat: 25 }, areas)).toBe(false);
    expect(areas.bounds).toEqual({
      minLng: 10,
      minLat: 10,
      maxLng: 40,
      maxLat: 40,
    });
  });

  it.each([
    ['text that is not JSON', 'all of Uzbekistan'],
    ['another geometry', '{"type":"Point","coordinates":[69,41]}'],
    ['a wrapper around the geometry', '{"type":"Feature","geometry":{}}'],
    ['no rings', '{"type":"Polygon","coordinates":[]}'],
    ['no polygons', '{"type":"MultiPolygon","coordinates":[]}'],
    [
      'too few positions',
      '{"type":"Polygon","coordinates":[[[1,1],[2,2],[1,1]]]}',
    ],
    [
      'a ring left open',
      '{"type":"Polygon","coordinates":[[[1,1],[2,1],[2,2],[1,2]]]}',
    ],
    [
      'a ring with no area',
      '{"type":"Polygon","coordinates":[[[1,1],[2,2],[3,3],[1,1]]]}',
    ],
    [
      'a latitude out of range',
      '{"type":"Polygon","coordinates":[[[1,91],[2,1],[2,2],[1,91]]]}',
    ],
    [
      'a position in words',
      '{"type":"Polygon","coordinates":[[["1","1"],[2,1],[2,2],["1","1"]]]}',
    ],
  ])('refuses to boot on %s, rather than guess', (_, raw) => {
    expect(() =>
      validateEnv({ NODE_ENV: 'test', DELIVERY_COVERAGE_POLYGON: raw }),
    ).toThrow(/DELIVERY_COVERAGE_POLYGON must be a GeoJSON/);
  });
});
