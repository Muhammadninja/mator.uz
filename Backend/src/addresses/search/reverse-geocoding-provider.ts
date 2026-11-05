import type { GeoPoint } from '../../shipping/routing/routing-provider';
import type { AddressSearchLanguage } from './address-search-provider';

/**
 * The seam between "what is at this point" and whoever knows. Separate from address search and
 * from routing, so each can move to another provider alone.
 */
export const REVERSE_GEOCODING_PROVIDER = Symbol('REVERSE_GEOCODING_PROVIDER');

export interface PointAddress {
  city: string | null;
  district: string | null;
  street: string | null;
  house: string | null;
}

export interface ReverseGeocodingProvider {
  /** Credit the data's licence requires wherever these results are shown, if any. */
  readonly attribution: string | null;

  /**
   * What is known about a point, or null when nothing is, which is common and not a failure:
   * a point with no address is still a place a courier can go.
   *
   * @throws ReverseGeocodingUnavailableError when no answer could be had right now.
   */
  describe(
    point: GeoPoint,
    language: AddressSearchLanguage,
  ): Promise<PointAddress | null>;
}

export class ReverseGeocodingUnavailableError extends Error {
  override readonly name = 'ReverseGeocodingUnavailableError';
}
