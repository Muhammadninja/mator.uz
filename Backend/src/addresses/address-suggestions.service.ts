import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { CacheService } from '../redis/cache.service';
import { RedisKeys } from '../redis/redis.keys';
import {
  DELIVERY_ADDRESS_COORDINATES_INVALID,
  DeliveryCoverage,
  isWithinCoverage,
} from '../shipping/delivery-coverage';
import { readDeliveryCoverage } from '../shipping/delivery.config';
import { GeoPoint, toGeoPoint } from '../shipping/routing/routing-provider';
import { AddressPointQueryDto } from './dto/address-point.query.dto';
import { AddressSuggestionsQueryDto } from './dto/address-suggestions.query.dto';
import {
  ADDRESS_SEARCH_PROVIDER,
  AddressSearchQuery,
  AddressSearchUnavailableError,
  FoundAddress,
} from './search/address-search-provider';
import {
  PointAddress,
  REVERSE_GEOCODING_PROVIDER,
} from './search/reverse-geocoding-provider';
// `import type` is required: with isolatedModules + emitDecoratorMetadata, a type used in a
// decorated signature must not be emitted as a value import.
import type { AddressSearchProvider } from './search/address-search-provider';
import type { ReverseGeocodingProvider } from './search/reverse-geocoding-provider';

export const ADDRESS_SEARCH_UNAVAILABLE = 'ADDRESS_SEARCH_UNAVAILABLE';

const SUGGESTION_LIMIT = 8;

/**
 * UzMaps' docs say results are only as current as its last data build and nothing about
 * storing them, so these are kept short. They spare a paid call for what many buyers type and
 * for a point confirmed twice. A hash keys each, so neither what is typed nor where anyone is
 * sits in the keyspace.
 */
const SEARCH_CACHE_TTL_SECONDS = 60 * 60;
const REVERSE_CACHE_TTL_SECONDS = 24 * 60 * 60;

const hashOf = (parts: readonly unknown[]): string =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex');

/** Near enough to rank by, without saying exactly where the map is. */
const roughly = (value: number): number => Math.round(value * 100) / 100;

/** Whether a result names the city the buyer typed. Only ever used to order the results. */
function mentionsCity(found: FoundAddress, city: string): boolean {
  return [found.city, found.district, found.subtitle].some((part) =>
    part?.toLocaleLowerCase().includes(city),
  );
}

/**
 * Finding places for a buyer choosing where a courier should go. Both are conveniences and
 * neither is needed to deliver: a point chosen on the map is a whole destination by itself,
 * with or without a recognised address, so nothing here can stop a buyer from choosing one.
 * The app saves what they choose through POST /v1/addresses, like any other address.
 */
@Injectable()
export class AddressSuggestionsService {
  private readonly logger = new Logger(AddressSuggestionsService.name);
  private readonly coverage: DeliveryCoverage | null;

  constructor(
    @Inject(ADDRESS_SEARCH_PROVIDER)
    private readonly search: AddressSearchProvider,
    @Inject(REVERSE_GEOCODING_PROVIDER)
    private readonly reverse: ReverseGeocodingProvider,
    private readonly cache: CacheService,
    config: ConfigService,
  ) {
    this.coverage = readDeliveryCoverage((key) => config.get<string>(key));
  }

  async suggest(dto: AddressSuggestionsQueryDto) {
    const near =
      dto.near_lat !== undefined && dto.near_lng !== undefined
        ? toGeoPoint(roughly(dto.near_lat), roughly(dto.near_lng))
        : null;
    const query: AddressSearchQuery = {
      street: dto.street.trim(),
      house: dto.house?.trim() || undefined,
      language: dto.lang ?? 'uz',
      limit: SUGGESTION_LIMIT,
      mode: dto.mode ?? 'autocomplete',
      ...(near ? { near } : {}),
      ...(this.coverage ? { bounds: this.coverage.bounds } : {}),
    };

    let found: FoundAddress[];
    try {
      found = await this.cache.remember(
        RedisKeys.cacheAddressSearch(
          hashOf([
            query.mode,
            query.language,
            query.street.toLocaleLowerCase(),
            query.house?.toLocaleLowerCase() ?? null,
            near,
            query.bounds ?? null,
          ]),
        ),
        SEARCH_CACHE_TTL_SECONDS,
        () => this.search.search(query),
      );
    } catch (err) {
      if (err instanceof AddressSearchUnavailableError) {
        throw new ServiceUnavailableException({
          code: ADDRESS_SEARCH_UNAVAILABLE,
          message: 'Address search is not available right now.',
        });
      }
      throw err;
    }

    // Offering a place the address endpoint would then refuse helps nobody.
    const { coverage } = this;
    const deliverable = coverage
      ? found.filter((address) => isWithinCoverage(address, coverage))
      : found;
    const city = dto.city?.trim().toLocaleLowerCase();
    const ranked = city
      ? [
          ...deliverable.filter((address) => mentionsCity(address, city)),
          ...deliverable.filter((address) => !mentionsCity(address, city)),
        ]
      : deliverable;

    return {
      items: ranked.map((address) => ({
        id: address.id,
        title: address.title,
        subtitle: address.subtitle,
        city: address.city,
        district: address.district,
        street: address.street,
        house_number: address.house,
        lat: address.lat,
        lng: address.lng,
      })),
      attribution: this.search.attribution,
    };
  }

  /**
   * What the app can say about a point once the buyer has confirmed it: whether couriers go
   * there, and whatever is known about the address, to save them typing it. Asked once per
   * confirmed point, never while the map moves. It never fails: not knowing the address only
   * means the buyer has nothing filled in for them.
   */
  async describePoint(dto: AddressPointQueryDto) {
    const point = toGeoPoint(dto.lat, dto.lng);
    if (!point) {
      throw new BadRequestException({
        code: DELIVERY_ADDRESS_COORDINATES_INVALID,
        message: 'A location needs a valid latitude and longitude together.',
      });
    }
    const withinCoverage = this.coverage
      ? isWithinCoverage(point, this.coverage)
      : null;
    // No paid call for a place that is about to be refused anyway.
    const address =
      withinCoverage === false
        ? null
        : await this.addressAt(point, dto.lang ?? 'uz');

    return {
      address: address
        ? {
            city: address.city,
            district: address.district,
            street: address.street,
            house_number: address.house,
          }
        : null,
      within_coverage: withinCoverage,
      attribution: address ? this.reverse.attribution : null,
    };
  }

  private async addressAt(
    point: GeoPoint,
    language: AddressSearchQuery['language'],
  ): Promise<PointAddress | null> {
    try {
      // Wrapped, because `remember` cannot tell a cached "nothing here" from a miss.
      const { address } = await this.cache.remember(
        RedisKeys.cacheAddressReverse(hashOf([point.lat, point.lng, language])),
        REVERSE_CACHE_TTL_SECONDS,
        async () => ({ address: await this.reverse.describe(point, language) }),
      );
      return address;
    } catch (err) {
      const reason = err instanceof Error ? err.name : 'unknown';
      this.logger.warn(`No address for a confirmed point: ${reason}`);
      return null;
    }
  }
}
