import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { MetricsService } from '../../metrics/metrics.service';
import { toGeoPoint } from '../../shipping/routing/routing-provider';
import {
  UZMAPS_ATTRIBUTION,
  uzmapsSearchKey,
} from '../../shipping/routing/uzmaps-keys';
import {
  errorDetail,
  uzmapsFailure,
} from '../../shipping/routing/uzmaps-routing.provider';
import {
  AddressSearchMode,
  AddressSearchProvider,
  AddressSearchQuery,
  AddressSearchUnavailableError,
  FoundAddress,
} from './address-search-provider';

/** https://docs.uzmaps.uz/http-search/ */
const SEARCH_URLS: Record<AddressSearchMode, string> = {
  autocomplete: 'https://uzmaps.uz/api/autocomplete',
  search: 'https://uzmaps.uz/api/search',
};

/** A buyer is typing: a slow answer is worth less than none. */
const TIMEOUT_MS = 5_000;

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Everything a courier can be sent to. Rivers and mountains are all that is left out. */
const SEARCHED_KINDS = 'address,street,place,poi';

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** One result, or nothing when it names no real place to send a courier. */
function toFoundAddress(result: unknown): FoundAddress[] {
  const r = (result ?? {}) as Record<string, unknown>;
  const point = toGeoPoint(r.lat as number, r.lon as number);
  const label = text(r.label);
  const title = text(r.name) ?? label;
  if (!point || !title) return [];
  const address = (r.address ?? {}) as Record<string, unknown>;
  return [
    {
      id:
        typeof r.id === 'string' || typeof r.id === 'number'
          ? String(r.id)
          : `${point.lat},${point.lng}`,
      title,
      subtitle: label === title ? null : label,
      city: text(address.city) ?? text(address.region),
      district: text(address.district),
      street: text(address.street),
      house: text(address.housenumber),
      lat: point.lat,
      lng: point.lng,
    },
  ];
}

/**
 * Address search through UzMaps, from the backend only: the key stays here, and neither the
 * key nor what the buyer typed reaches a log, which is why a failure is reduced to a status
 * and the provider's own message.
 *
 * The docs state how a house number in the query is read ("Amir Temur 12"), and say nothing
 * about a city name in it, so the city is not sent: it could only cost matches. It orders
 * the results instead, in AddressSuggestionsService.
 *
 * When a house is not in UzMaps' data the docs say the street comes back instead, so a result
 * can be street-level. Its point is then somewhere on that street, not at the buyer's door.
 */
@Injectable()
export class UzmapsAddressSearchProvider implements AddressSearchProvider {
  readonly attribution = UZMAPS_ATTRIBUTION;
  private readonly logger = new Logger(UzmapsAddressSearchProvider.name);

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async search(query: AddressSearchQuery): Promise<FoundAddress[]> {
    const apiKey = uzmapsSearchKey((key) => this.config.get<string>(key));
    if (!apiKey) {
      this.logger.error('No UzMaps key is set: address search is off.');
      throw new AddressSearchUnavailableError('No UzMaps key is set');
    }

    const { bounds, near } = query;
    let body: unknown;
    try {
      const response = await axios.get<unknown>(SEARCH_URLS[query.mode], {
        // The text and the map context, and nothing about who is asking.
        params: {
          q: [query.street, query.house].filter(Boolean).join(' '),
          lang: query.language,
          limit: query.limit,
          kinds: SEARCHED_KINDS,
          ...(bounds
            ? {
                bbox: `${bounds.minLng},${bounds.minLat},${bounds.maxLng},${bounds.maxLat}`,
              }
            : {}),
          ...(near ? { lat: near.lat, lon: near.lng } : {}),
        },
        headers: { 'X-API-Key': apiKey },
        timeout: TIMEOUT_MS,
        maxContentLength: MAX_RESPONSE_BYTES,
      });
      body = response.data;
    } catch (err) {
      throw this.refusal(err);
    }

    const results = (body as { results?: unknown } | null | undefined)?.results;
    if (!Array.isArray(results)) {
      this.metrics?.recordUzmapsRequest('search', 'failed');
      this.logger.warn('UzMaps answered 200 without a list of results');
      throw new AddressSearchUnavailableError(
        'UzMaps answered without a list of results',
      );
    }
    const found = results.flatMap(toFoundAddress);
    this.metrics?.recordUzmapsRequest(
      'search',
      found.length > 0 ? 'success' : 'empty',
    );
    return found;
  }

  private refusal(err: unknown): Error {
    const response = axios.isAxiosError(err) ? err.response : undefined;
    if (!response) {
      this.metrics?.recordUzmapsRequest('search', 'failed');
      const detail = axios.isAxiosError(err)
        ? `network error (${err.code ?? 'unknown'})`
        : 'unexpected failure';
      this.logger.warn(`UzMaps address search failed: ${detail}`);
      return new AddressSearchUnavailableError(detail);
    }
    this.metrics?.recordUzmapsRequest('search', uzmapsFailure(response.status));
    const line = `UzMaps address search answered ${response.status}: ${errorDetail(response.data)}`;
    // A bad key or an exhausted quota stops address search until someone acts.
    if ([401, 403, 429].includes(response.status)) this.logger.error(line);
    else this.logger.warn(line);
    return new AddressSearchUnavailableError(line);
  }
}
