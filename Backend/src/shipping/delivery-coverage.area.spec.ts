// Mator's approved courier area as it will actually be configured: Tashkent City and the New
// Tashkent project territory, and nothing else in Tashkent Region. The file is a practical
// reconstruction, not a cadastral boundary: its sources are in the env file's comment lines.
// The city's detached Mirzo Ulug'bek settlement is left out by decision.
// The points below were generated from this geometry on 2026-11-05. The 300 m pairs also agree with
// an independent trace of the official map (Senate SQ-379-IV, Appendix 22) and the New Tashkent
// relation.

import { existsSync, readFileSync } from 'fs';
import { parse } from 'dotenv';
import { join } from 'path';
import { validateEnv } from '../env.validation';
import { isWithinCoverage, parseCoverage } from './delivery-coverage';
import { readDeliveryCoverage } from './delivery.config';

const DIR = join(__dirname, '../../config/delivery-coverage');
const GEOJSON = readFileSync(
  join(DIR, 'delivery-coverage.geojson'),
  'utf8',
).trim();
const ENV_FILE = readFileSync(join(DIR, 'delivery-coverage.env.txt'));

type Ring = number[][];
const rings = (
  JSON.parse(GEOJSON) as { coordinates: Ring[][] }
).coordinates.flat();

/** Square kilometres, on a local projection: plenty for a sanity range. */
function areaKm2(ring: Ring): number {
  const toRadians = Math.PI / 180;
  const kmPerDegree = 111.32;
  const cos = Math.cos(41.3 * toRadians);
  let twice = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    twice +=
      ring[i][0] * cos * kmPerDegree * (ring[i + 1][1] * kmPerDegree) -
      ring[i + 1][0] * cos * kmPerDegree * (ring[i][1] * kmPerDegree);
  }
  return Math.abs(twice) / 2;
}

describe('the approved delivery area', () => {
  const coverage = parseCoverage(GEOJSON);
  const covers = (lat: number, lng: number) =>
    isWithinCoverage({ lat, lng }, coverage);

  describe('as an environment value', () => {
    it('the env line holds exactly the geometry, and nothing else', () => {
      const env = parse(ENV_FILE);
      expect(Object.keys(env)).toEqual(['DELIVERY_COVERAGE_POLYGON']);
      expect(env.DELIVERY_COVERAGE_POLYGON).toBe(GEOJSON);
    });

    it('is what the app reads and boots with', () => {
      const { DELIVERY_COVERAGE_POLYGON } = parse(ENV_FILE);
      expect(() =>
        validateEnv({
          NODE_ENV: 'production',
          PAYME_MERCHANT_ID: 'merchant-1',
          PAYME_MERCHANT_KEY: 'merchant-secret',
          UZMAPS_API_KEY: 'uzmaps-key',
          DELIVERY_COVERAGE_POLYGON,
        }),
      ).not.toThrow();
      const read = readDeliveryCoverage((key) =>
        key === 'DELIVERY_COVERAGE_POLYGON'
          ? DELIVERY_COVERAGE_POLYGON
          : undefined,
      );
      expect(read?.polygons).toEqual(coverage.polygons);
    });

    it('fits in an environment variable, whatever loads it', () => {
      expect(Buffer.byteLength(GEOJSON)).toBeLessThan(128 * 1024);
    });
  });

  describe('as a geometry', () => {
    it('is one connected area with no holes', () => {
      expect(coverage.polygons).toHaveLength(1);
      expect(coverage.polygons[0]).toHaveLength(1);
      expect(coverage.polygons[0][0]).toHaveLength(1081);
    });

    it('is [longitude, latitude], WGS84, around Tashkent', () => {
      expect(coverage.bounds).toEqual({
        minLng: 69.121856,
        minLat: 41.1577334,
        maxLng: 69.525908,
        maxLat: 41.3984299,
      });
    });

    it('has closed rings, wound the way GeoJSON requires', () => {
      for (const ring of rings) {
        expect(ring[0]).toEqual(ring[ring.length - 1]);
        let twice = 0;
        for (let i = 0; i < ring.length - 1; i += 1) {
          twice += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
        }
        expect(twice).toBeGreaterThan(0);
      }
    });

    it('is the size of the city with New Tashkent: Tashkent Region is some 15,000 km2', () => {
      const total = rings.reduce((sum, ring) => sum + areaKm2(ring), 0);
      expect(total).toBeGreaterThan(625);
      expect(total).toBeLessThan(640);
    });

    it('is not the old polygon, whose city part had known boundary errors', () => {
      expect(existsSync(join(DIR, 'tashkent-city.geojson'))).toBe(false);
      expect(existsSync(join(DIR, 'tashkent-city.env.txt'))).toBe(false);
      expect(covers(41.352149, 69.419189)).toBe(true);
      expect(covers(41.343404, 69.468082)).toBe(false);
    });
  });

  describe('inside Tashkent City', () => {
    it.each([
      ['Amir Temur Square, the centre', 41.3111, 69.2797],
      ['Chorsu (UzMaps docs example)', 41.3258649, 69.2368152],
      ['Tashkent TV Tower', 41.346, 69.285],
      ['Tashkent International Airport', 41.258, 69.281],
      ['Bektemir district', 41.227936, 69.336245],
      ['Chilonzor district', 41.267408, 69.191939],
      ['Mirobod district', 41.275227, 69.290181],
      ["Mirzo Ulug'bek district", 41.336214, 69.347842],
      ['Olmazor district', 41.359124, 69.218787],
      ['Sergeli district', 41.232177, 69.254514],
      ['Shayxontohur district', 41.324858, 69.231383],
      ['Uchtepa district', 41.296184, 69.167056],
      ['Yakkasaroy district', 41.28209, 69.251113],
      ['Yangihayot district', 41.202259, 69.216046],
      ['Yashnobod district', 41.293689, 69.354916],
      ['Yunusobod district', 41.353906, 69.302884],
    ])('%s is covered', (_, lat, lng) => {
      expect(covers(lat, lng)).toBe(true);
    });
  });

  describe('inside New Tashkent', () => {
    it.each([
      ['New Tashkent, middle', 41.240701, 69.449366],
      ['New Tashkent, 300 m inside its north end', 41.31733, 69.450868],
      ['New Tashkent, 300 m inside its east end', 41.300183, 69.521766],
      ['New Tashkent, 300 m inside its south end', 41.160981, 69.429471],
    ])('%s is covered', (_, lat, lng) => {
      expect(covers(lat, lng)).toBe(true);
    });
  });

  describe('left out by decision', () => {
    it.each([
      ["Mirzo Ulug'bek settlement, the detached part", 41.41169, 69.45394],
    ])('%s is not covered', (_, lat, lng) => {
      expect(covers(lat, lng)).toBe(false);
    });
  });

  describe('the sections corrected against the 2021 act', () => {
    it.each([
      ['Lobe around point 5, restored', 41.352149, 69.419189, true],
      ['Wedge east of points 7-10, removed', 41.343404, 69.468082, false],
      [
        'Golf-club land at points 12-14: out of the city, in New Tashkent',
        41.259459,
        69.38113,
        true,
      ],
      [
        'Parcel the act moved to Zangiota (Appendix 9)',
        41.189296,
        69.189453,
        false,
      ],
      [
        'Chirchiq channel between the city and New Tashkent',
        41.295481,
        69.413521,
        false,
      ],
      ['120 m inside the line near point 32', 41.222616, 69.176044, true],
      ['120 m outside the line near point 32', 41.222287, 69.173214, false],
      ['120 m inside the line near point 31', 41.225175, 69.173645, true],
      ['120 m outside the line near point 31', 41.223998, 69.171242, false],
    ] as [string, number, number, boolean][])('%s', (_, lat, lng, expected) => {
      expect(covers(lat, lng)).toBe(expected);
    });
  });

  describe('in the rest of Tashkent Region', () => {
    it.each([
      ['Chirchiq', 41.4689, 69.5822],
      ['Olmaliq', 40.8447, 69.5983],
      ['Nurafshon', 41.04, 69.358],
      ["Yangiyo'l", 41.1122, 69.0472],
      ['Keles', 41.4033, 69.22],
      ['Angren', 41.0167, 70.1436],
      ["G'azalkent", 41.56, 69.77],
      ['Bekobod', 40.22, 69.27],
      ['Parkent', 41.295, 69.675],
      ['Chinoz', 40.934, 68.763],
      ['Jumabazar (OSM place)', 41.23547, 69.51027],
      ['Erkin (OSM place)', 41.22806, 69.16857],
      ['Eshanguzar (OSM place)', 41.25083, 69.15174],
      ['Zangiata (OSM place)', 41.20171, 69.16201],
      ['Salar (OSM place)', 41.37507, 69.35138],
    ])('%s is not covered', (_, lat, lng) => {
      expect(covers(lat, lng)).toBe(false);
    });
  });

  describe('elsewhere', () => {
    it.each([
      ['Samarkand', 39.6542, 66.9597],
      ['Shymkent, Kazakhstan', 42.3417, 69.5901],
    ])('%s is not covered', (_, lat, lng) => {
      expect(covers(lat, lng)).toBe(false);
    });
  });

  describe('300 m either side of the boundary, all the way round', () => {
    it.each([
      ['position 1/14', 41.32532, 69.449011],
      ['position 2/14', 41.330201, 69.453148],
      ['position 3/14', 41.359988, 69.403753],
      ['position 4/14', 41.370975, 69.320214],
      ['position 5/14', 41.394085, 69.232472],
      ['position 6/14', 41.334302, 69.167012],
      ['position 7/14', 41.270901, 69.129084],
      ['position 8/14', 41.23765, 69.169046],
      ['position 9/14', 41.180153, 69.204635],
      ['position 10/14', 41.171621, 69.295806],
      ['position 11/14', 41.163054, 69.402073],
      ['position 12/14', 41.192413, 69.483996],
      ['position 13/14', 41.269579, 69.517142],
      ['position 14/14', 41.314441, 69.464128],
    ])('inside the line, %s, is covered', (_, lat, lng) => {
      expect(covers(lat, lng)).toBe(true);
    });

    it.each([
      ['position 1/14', 41.321686, 69.454318],
      ['position 2/14', 41.32629, 69.458096],
      ['position 3/14', 41.362116, 69.410346],
      ['position 4/14', 41.372767, 69.326983],
      ['position 5/14', 41.398438, 69.228218],
      ['position 6/14', 41.3359, 69.160162],
      ['position 7/14', 41.275101, 69.124576],
      ['position 8/14', 41.240962, 69.163388],
      ['position 9/14', 41.176815, 69.199008],
      ['position 10/14', 41.166226, 69.295381],
      ['position 11/14', 41.157666, 69.401527],
      ['position 12/14', 41.189284, 69.48983],
      ['position 13/14', 41.268316, 69.524106],
      ['position 14/14', 41.319749, 69.465475],
    ])('outside the line, %s, is not covered', (_, lat, lng) => {
      expect(covers(lat, lng)).toBe(false);
    });
  });
});
