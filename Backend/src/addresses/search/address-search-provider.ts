import type { CoverageBounds } from '../../shipping/delivery-coverage';
import type { GeoPoint } from '../../shipping/routing/routing-provider';

/**
 * The seam between address search and whoever holds the address data, so another provider is
 * a new class and one line in AddressesModule. Same shape as the routing seam next to it.
 */
export const ADDRESS_SEARCH_PROVIDER = Symbol('ADDRESS_SEARCH_PROVIDER');

export type AddressSearchLanguage = 'uz' | 'ru' | 'en';

/** 'autocomplete' while the buyer types, 'search' when they ask for what they typed. */
export type AddressSearchMode = 'autocomplete' | 'search';

/** Only what the search needs. It carries nothing about who is asking, by design. */
export interface AddressSearchQuery {
  street: string;
  house?: string;
  language: AddressSearchLanguage;
  limit: number;
  mode: AddressSearchMode;
  /** Where the map is looking, to rank what is near it first. */
  near?: GeoPoint;
  /** The delivery area, when one is configured. */
  bounds?: CoverageBounds;
}

export interface FoundAddress {
  /** Good for telling results apart in one answer, not for keeping: it can change. */
  id: string;
  title: string;
  subtitle: string | null;
  city: string | null;
  district: string | null;
  street: string | null;
  /** Null when the match is a street or a place rather than a numbered building. */
  house: string | null;
  lat: number;
  lng: number;
}

export interface AddressSearchProvider {
  /** Credit the data's licence requires wherever these results are shown, if any. */
  readonly attribution: string | null;

  /**
   * Matching places, best first. Nothing matching is an empty list, not an error.
   *
   * @throws AddressSearchUnavailableError when no answer could be had right now.
   */
  search(query: AddressSearchQuery): Promise<FoundAddress[]>;
}

/** The provider gave no usable answer: down, too slow, refusing us, or talking nonsense. */
export class AddressSearchUnavailableError extends Error {
  override readonly name = 'AddressSearchUnavailableError';
}
