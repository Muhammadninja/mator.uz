import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { MetricsService } from '../../metrics/metrics.service';
import type { GeoPoint } from '../../shipping/routing/routing-provider';
import {
  UZMAPS_ATTRIBUTION,
  uzmapsSearchKey,
} from '../../shipping/routing/uzmaps-keys';
import {
  errorDetail,
  uzmapsFailure,
} from '../../shipping/routing/uzmaps-routing.provider';
import type { AddressSearchLanguage } from './address-search-provider';
import {
  PointAddress,
  ReverseGeocodingProvider,
  ReverseGeocodingUnavailableError,
} from './reverse-geocoding-provider';

/** https://docs.uzmaps.uz/http-search/ */
const REVERSE_URL = 'https://uzmaps.uz/api/reverse';

/** The buyer is waiting on this only for a convenience, so it does not wait long. */
const TIMEOUT_MS = 4_000;

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Reverse geocoding through UzMaps, billed as its own product. Reads the `address` object, not
 * `label`: when nothing is found UzMaps still answers with a label, "Dropped pin" or its
 * translation, which must not become someone's address. Neither the key nor the point reaches
 * a log.
 */
@Injectable()
export class UzmapsReverseGeocodingProvider implements ReverseGeocodingProvider {
  readonly attribution = UZMAPS_ATTRIBUTION;
  private readonly logger = new Logger(UzmapsReverseGeocodingProvider.name);

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async describe(
    point: GeoPoint,
    language: AddressSearchLanguage,
  ): Promise<PointAddress | null> {
    const apiKey = uzmapsSearchKey((key) => this.config.get<string>(key));
    if (!apiKey) {
      throw new ReverseGeocodingUnavailableError('No UzMaps key is set');
    }

    let body: unknown;
    try {
      const response = await axios.get<unknown>(REVERSE_URL, {
        params: { lat: point.lat, lon: point.lng, lang: language },
        headers: { 'X-API-Key': apiKey },
        timeout: TIMEOUT_MS,
      });
      body = response.data;
    } catch (err) {
      throw this.refusal(err);
    }

    const address = ((body as { address?: unknown } | null | undefined)
      ?.address ?? {}) as Record<string, unknown>;
    const found: PointAddress = {
      city: text(address.city) ?? text(address.region),
      district: text(address.district),
      street: text(address.street) ?? text(address.neighbourhood),
      house: text(address.housenumber),
    };
    const known = Object.values(found).some(Boolean);
    this.metrics?.recordUzmapsRequest('geocoding', known ? 'success' : 'empty');
    return known ? found : null;
  }

  private refusal(err: unknown): Error {
    const response = axios.isAxiosError(err) ? err.response : undefined;
    if (!response) {
      this.metrics?.recordUzmapsRequest('geocoding', 'failed');
      this.logger.warn('UzMaps reverse geocoding gave no answer');
      return new ReverseGeocodingUnavailableError('no answer');
    }
    this.metrics?.recordUzmapsRequest(
      'geocoding',
      uzmapsFailure(response.status),
    );
    const line = `UzMaps reverse geocoding answered ${response.status}: ${errorDetail(response.data)}`;
    if ([401, 403, 429].includes(response.status)) this.logger.error(line);
    else this.logger.warn(line);
    return new ReverseGeocodingUnavailableError(line);
  }
}
