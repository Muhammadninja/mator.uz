import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { MetricsService } from '../../metrics/metrics.service';
import { uzmapsRoutingKey } from './uzmaps-keys';
import {
  GeoPoint,
  RouteNotFoundError,
  RoutingProvider,
  RoutingUnavailableError,
} from './routing-provider';

/** https://docs.uzmaps.uz/http-routing/ */
const ROUTE_URL = 'https://uzmaps.uz/api/route';

/**
 * Below UzMaps' own 25-second engine timeout: a buyer is waiting on this at checkout, and
 * a slow answer is better refused than kept waiting for.
 */
const TIMEOUT_MS = 10_000;

/** Geometry for even a cross-country trip is far below this; only a fault could reach it. */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

const MAX_DETAIL_LENGTH = 200;

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * The distance of the fastest route, or null when no route is usable. Duration is read
 * only to compare routes here, and goes no further. A route with no valid duration cannot
 * be compared, so it is skipped rather than assumed fast. On a tie the earlier route wins:
 * UzMaps lists its recommended route first.
 */
export function fastestRouteDistance(
  routes: readonly unknown[],
): number | null {
  let fastest: { distance: number; duration: number } | null = null;
  for (const route of routes) {
    const { distance, duration } = (route ?? {}) as Record<string, unknown>;
    if (!isPositiveNumber(distance) || !isPositiveNumber(duration)) continue;
    if (!fastest || duration < fastest.duration) {
      fastest = { distance, duration };
    }
  }
  return fastest ? fastest.distance : null;
}

/** What a refusal by UzMaps means for whoever is watching the bill. */
export function uzmapsFailure(
  status: number,
): 'refused' | 'rate_limited' | 'failed' {
  if (status === 429) return 'rate_limited';
  return status === 401 || status === 403 ? 'refused' : 'failed';
}

/** The provider's own words about a refusal, cut short. */
export function errorDetail(body: unknown): string {
  const { error, message } = (body ?? {}) as Record<string, unknown>;
  const text = [message, error].find(
    (part): part is string => typeof part === 'string' && part.length > 0,
  );
  return (text ?? 'no detail').slice(0, MAX_DETAIL_LENGTH);
}

/**
 * Whether a 502 says the points cannot be connected, as opposed to the engine being down.
 * UzMaps sends `no route found` when the engine finds no trip, and `routing: <engine
 * message>` when the engine rejects the request ("No suitable edges near location"). The
 * two that are about the engine itself are `routing engine unavailable: ...` and
 * `routing: HTTP <status>`.
 */
function isNoRouteAnswer(body: unknown): boolean {
  const { error } = (body ?? {}) as Record<string, unknown>;
  if (typeof error !== 'string') return false;
  if (error === 'no route found') return true;
  return error.startsWith('routing: ') && !error.startsWith('routing: HTTP ');
}

/**
 * Road routing through UzMaps. Only ever called from the backend: the key must not reach
 * the mobile app, and it must not reach a log either, which is why errors here are reduced
 * to a status and the provider's message and the axios error (whose config holds the
 * headers) is never logged or passed on.
 */
@Injectable()
export class UzmapsRoutingProvider implements RoutingProvider {
  readonly name = 'uzmaps';
  private readonly logger = new Logger(UzmapsRoutingProvider.name);

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async routeDistanceMeters(
    origin: GeoPoint,
    destination: GeoPoint,
  ): Promise<number> {
    const apiKey = uzmapsRoutingKey((key) => this.config.get<string>(key));
    if (!apiKey) {
      this.logger.error(
        'UZMAPS_API_KEY is not set: courier delivery cannot be priced.',
      );
      throw new RoutingUnavailableError('UZMAPS_API_KEY is not set');
    }

    let body: unknown;
    try {
      const response = await axios.post<unknown>(
        ROUTE_URL,
        {
          mode: 'car',
          alternatives: 3,
          shortest: false,
          // UzMaps takes [longitude, latitude], the reverse of how they are stored.
          points: [
            [origin.lng, origin.lat],
            [destination.lng, destination.lat],
          ],
        },
        {
          headers: { 'X-API-Key': apiKey },
          timeout: TIMEOUT_MS,
          maxContentLength: MAX_RESPONSE_BYTES,
        },
      );
      body = response.data;
    } catch (err) {
      throw this.refusal(err);
    }

    const routes = (body as { routes?: unknown } | null | undefined)?.routes;
    if (!Array.isArray(routes)) {
      this.metrics?.recordUzmapsRequest('routing', 'failed');
      this.logger.warn('UzMaps answered 200 without a list of routes');
      throw new RoutingUnavailableError(
        'UzMaps answered without a list of routes',
      );
    }
    const distance = fastestRouteDistance(routes);
    if (distance === null) {
      this.metrics?.recordUzmapsRequest('routing', 'empty');
      throw new RouteNotFoundError('UzMaps returned no usable route');
    }
    this.metrics?.recordUzmapsRequest('routing', 'success');
    return distance;
  }

  private refusal(err: unknown): Error {
    if (!axios.isAxiosError(err)) {
      this.metrics?.recordUzmapsRequest('routing', 'failed');
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`UzMaps request failed: ${detail}`);
      return new RoutingUnavailableError(`UzMaps request failed: ${detail}`);
    }

    const response = err.response;
    if (!response) {
      this.metrics?.recordUzmapsRequest('routing', 'failed');
      const detail =
        err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT'
          ? `no answer within ${TIMEOUT_MS} ms`
          : `network error (${err.code ?? 'unknown'})`;
      this.logger.warn(`UzMaps request failed: ${detail}`);
      return new RoutingUnavailableError(`UzMaps request failed: ${detail}`);
    }

    const status = response.status;
    if (status === 502 && isNoRouteAnswer(response.data)) {
      this.metrics?.recordUzmapsRequest('routing', 'empty');
      return new RouteNotFoundError(errorDetail(response.data));
    }
    this.metrics?.recordUzmapsRequest('routing', uzmapsFailure(status));

    const line = `UzMaps answered ${status}: ${errorDetail(response.data)}`;
    // A bad key or an exhausted quota stops all courier pricing until someone acts, so it
    // is reported louder than a passing failure.
    if (status === 401 || status === 403 || status === 429) {
      this.logger.error(line);
    } else {
      this.logger.warn(line);
    }
    return new RoutingUnavailableError(line);
  }
}
