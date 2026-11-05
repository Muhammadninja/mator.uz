import type { GeoPoint } from './routing/routing-provider';

/** What a client can tell these refusals by. The app words each one itself. */
export const DELIVERY_ADDRESS_COORDINATES_INVALID =
  'DELIVERY_ADDRESS_COORDINATES_INVALID';
export const DELIVERY_OUTSIDE_COVERAGE = 'DELIVERY_OUTSIDE_COVERAGE';
/** No delivery area is configured, so couriers are off. Pickup is not affected. */
export const COURIER_DELIVERY_UNAVAILABLE = 'COURIER_DELIVERY_UNAVAILABLE';

/** A GeoJSON position, [longitude, latitude]. */
type Position = readonly [number, number];
type Ring = readonly Position[];

export interface CoverageBounds {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

/**
 * Where Mator's couriers go, as an operator configured it. There is no default on purpose:
 * no one area can be assumed, and an unset area means couriers are off, not everywhere.
 */
export interface DeliveryCoverage {
  /** Each polygon is its outer boundary followed by any holes, as in GeoJSON. */
  polygons: readonly (readonly Ring[])[];
  /** The smallest box around all of them: a quick first check, and a search filter. */
  bounds: CoverageBounds;
}

function isPosition(value: unknown): value is Position {
  if (!Array.isArray(value) || value.length < 2) return false;
  const [lng, lat] = value as unknown[];
  return (
    typeof lng === 'number' &&
    typeof lat === 'number' &&
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    Math.abs(lng) <= 180 &&
    Math.abs(lat) <= 90
  );
}

/** Twice the signed area: zero means the ring encloses nothing. */
function ringArea(ring: Ring): number {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return area;
}

function parseRing(value: unknown): Ring {
  if (!Array.isArray(value) || value.length < 4 || !value.every(isPosition)) {
    throw new Error(
      'a ring needs at least four [longitude, latitude] positions',
    );
  }
  const ring = value;
  const [firstLng, firstLat] = ring[0];
  const [lastLng, lastLat] = ring[ring.length - 1];
  if (firstLng !== lastLng || firstLat !== lastLat) {
    throw new Error('a ring must end where it starts');
  }
  if (ringArea(ring) === 0) throw new Error('a ring must enclose an area');
  return ring.map(([lng, lat]): Position => [lng, lat]);
}

function parsePolygon(value: unknown): Ring[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('a polygon needs an outer ring');
  }
  return value.map(parseRing);
}

/**
 * Reads a GeoJSON Polygon or MultiPolygon. Only the geometry: wrap nothing around it.
 *
 * @throws Error saying what is wrong. It never falls back on anything: an area that does not
 * parse is not an area, and guessing one would send couriers somewhere nobody chose.
 */
export function parseCoverage(raw: string): DeliveryCoverage {
  const geometry = JSON.parse(raw) as { type?: unknown; coordinates?: unknown };
  let polygons: Ring[][];
  if (geometry?.type === 'Polygon') {
    polygons = [parsePolygon(geometry.coordinates)];
  } else if (geometry?.type === 'MultiPolygon') {
    if (
      !Array.isArray(geometry.coordinates) ||
      geometry.coordinates.length === 0
    ) {
      throw new Error('a MultiPolygon needs at least one polygon');
    }
    polygons = geometry.coordinates.map(parsePolygon);
  } else {
    throw new Error('the type must be Polygon or MultiPolygon');
  }

  const outer = polygons.flatMap((polygon) => polygon[0]);
  const lngs = outer.map(([lng]) => lng);
  const lats = outer.map(([, lat]) => lat);
  return {
    polygons,
    bounds: {
      minLng: Math.min(...lngs),
      minLat: Math.min(...lats),
      maxLng: Math.max(...lngs),
      maxLat: Math.max(...lats),
    },
  };
}

function isOnSegment(point: GeoPoint, a: Position, b: Position): boolean {
  const cross =
    (b[0] - a[0]) * (point.lat - a[1]) - (b[1] - a[1]) * (point.lng - a[0]);
  return (
    cross === 0 &&
    point.lng >= Math.min(a[0], b[0]) &&
    point.lng <= Math.max(a[0], b[0]) &&
    point.lat >= Math.min(a[1], b[1]) &&
    point.lat <= Math.max(a[1], b[1])
  );
}

function ringPosition(
  point: GeoPoint,
  ring: Ring,
): 'inside' | 'edge' | 'outside' {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i];
    const b = ring[j];
    if (isOnSegment(point, a, b)) return 'edge';
    const crosses =
      a[1] > point.lat !== b[1] > point.lat &&
      point.lng < ((b[0] - a[0]) * (point.lat - a[1])) / (b[1] - a[1]) + a[0];
    if (crosses) inside = !inside;
  }
  return inside ? 'inside' : 'outside';
}

/**
 * Whether couriers go to this point. It says nothing about who chose the point or where they
 * are: any destination in the area is a valid one, however close to a seller. The boundary
 * itself counts as inside, including the boundary of a hole.
 */
export function isWithinCoverage(
  point: GeoPoint,
  coverage: DeliveryCoverage,
): boolean {
  const { minLng, minLat, maxLng, maxLat } = coverage.bounds;
  if (
    point.lng < minLng ||
    point.lng > maxLng ||
    point.lat < minLat ||
    point.lat > maxLat
  ) {
    return false;
  }
  return coverage.polygons.some(
    ([outer, ...holes]) =>
      ringPosition(point, outer) !== 'outside' &&
      !holes.some((hole) => ringPosition(point, hole) === 'inside'),
  );
}
