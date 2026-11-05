/**
 * The seam between delivery pricing and whoever knows the roads. Pricing depends only on
 * this file, so another provider is a new class and one line in ShippingModule.
 *
 * A provider answers with a distance and nothing else. Whatever else it knows (duration,
 * geometry, alternatives) stays inside it, which is what keeps those facts out of prices,
 * orders, caches and API responses.
 */
export interface GeoPoint {
  lat: number;
  lng: number;
}

export const ROUTING_PROVIDER = Symbol('ROUTING_PROVIDER');

export interface RoutingProvider {
  /** Part of the route cache key, so a new provider never reads an old one's answers. */
  readonly name: string;

  /**
   * The road distance of the route the provider would drive from origin to destination:
   * finite and positive, in metres.
   *
   * @throws RouteNotFoundError when there is no way to drive between the two points.
   * @throws RoutingUnavailableError when no answer could be had right now.
   */
  routeDistanceMeters(origin: GeoPoint, destination: GeoPoint): Promise<number>;
}

/** The provider answered, and its answer is that no route exists. Retrying will not help. */
export class RouteNotFoundError extends Error {
  override readonly name = 'RouteNotFoundError';
}

/** The provider gave no usable answer: down, too slow, refusing us, or talking nonsense. */
export class RoutingUnavailableError extends Error {
  override readonly name = 'RoutingUnavailableError';
}

/**
 * The point stored coordinates name, or null when they name none: absent, not finite, out
 * of range, or exactly 0,0, which is what an unset client value looks like and is nowhere a
 * courier could go.
 *
 * Exactly as stored, never rounded: the buyer chose this point, the courier goes to it, and
 * the price, the route cache and the order snapshot all have to mean the same place.
 */
export function toGeoPoint(
  lat: number | null | undefined,
  lng: number | null | undefined,
): GeoPoint | null {
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}
