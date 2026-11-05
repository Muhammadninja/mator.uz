/**
 * Which UzMaps key each product uses. UzMaps meters one monthly allowance per key across all
 * its products, so a key shared with address search can be used up by people typing, and that
 * stops checkout pricing too. A second key for search keeps them apart. Neither ever leaves
 * the backend.
 */
export type UzmapsKeyRole = 'routing' | 'search';

function trimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function uzmapsRoutingKey(get: (key: string) => unknown): string | null {
  return trimmed(get('UZMAPS_API_KEY'));
}

/** Search and reverse geocoding. Falls back on the one key when no second is set. */
export function uzmapsSearchKey(get: (key: string) => unknown): string | null {
  return trimmed(get('UZMAPS_SEARCH_API_KEY')) ?? uzmapsRoutingKey(get);
}

/** The map data's licence requires this wherever UzMaps results are shown. */
export const UZMAPS_ATTRIBUTION =
  'Map data © OpenStreetMap contributors, licensed under the ODbL.';
