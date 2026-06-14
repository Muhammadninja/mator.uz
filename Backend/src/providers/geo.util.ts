const EARTH_RADIUS_M = 6_371_000;
const DEG_PER_M_LAT = 1 / 111_320;

export interface BBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/** Bounding box around a point for an indexed pre-filter before exact distance. */
export function bboxFromRadius(lat: number, lng: number, radiusM: number): BBox {
  const dLat = radiusM * DEG_PER_M_LAT;
  const dLng = (radiusM * DEG_PER_M_LAT) / Math.max(0.01, Math.cos(toRad(lat)));
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}
