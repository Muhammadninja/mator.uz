/**
 * Courier delivery configuration, validated once at boot (src/env.validation.ts).
 *
 * The rates are optional: unset means the defaults in delivery-pricing.ts. A rate that IS
 * set but makes no sense stops the boot instead of falling back, because falling back
 * would quietly charge customers something other than what the operator wrote down.
 */
import { DeliveryCoverage, parseCoverage } from './delivery-coverage';
import { DEFAULT_DELIVERY_RATES, DeliveryRates } from './delivery-pricing';

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

const isWholePositive = (text: string): boolean =>
  /^\d+$/.test(text) && Number(text) > 0 && Number.isSafeInteger(Number(text));

/** The rates the environment states, and everything wrong with them. */
function parseDeliveryRates(get: (key: string) => unknown): {
  rates: DeliveryRates;
  errors: string[];
} {
  const errors: string[] = [];
  let { tierPricesUzs, extraKmPriceUzs } = DEFAULT_DELIVERY_RATES;

  const rawTiers = asTrimmedString(get('DELIVERY_TIER_PRICES_UZS'));
  if (rawTiers) {
    const parts = rawTiers.split(',').map((part) => part.trim());
    const prices = parts.map(Number);
    if (!parts.every(isWholePositive)) {
      errors.push(
        'DELIVERY_TIER_PRICES_UZS must be a comma-separated list of positive whole UZS ' +
          'amounts, one per kilometre, starting with the price of the first kilometre.',
      );
    } else if (prices.some((price, i) => i > 0 && price < prices[i - 1])) {
      errors.push(
        'DELIVERY_TIER_PRICES_UZS must not get cheaper as the distance grows.',
      );
    } else {
      tierPricesUzs = prices;
    }
  }

  const rawExtra = asTrimmedString(get('DELIVERY_EXTRA_KM_PRICE_UZS'));
  if (rawExtra) {
    if (isWholePositive(rawExtra)) {
      extraKmPriceUzs = Number(rawExtra);
    } else {
      errors.push(
        'DELIVERY_EXTRA_KM_PRICE_UZS must be a positive whole UZS amount.',
      );
    }
  }

  return { rates: { tierPricesUzs, extraKmPriceUzs }, errors };
}

/** The configured rates. Boot has already refused invalid ones, so this one reads them. */
export function readDeliveryRates(
  get: (key: string) => unknown,
): DeliveryRates {
  return parseDeliveryRates(get).rates;
}

/**
 * The delivery area the environment states, and what is wrong with it. Unset means no area:
 * couriers are off and pickup carries on. That is a state to run in, not a misconfiguration,
 * so it does not stop the boot. An area that IS set but does not parse does.
 */
function parseDeliveryCoverage(get: (key: string) => unknown): {
  coverage: DeliveryCoverage | null;
  errors: string[];
} {
  const raw = asTrimmedString(get('DELIVERY_COVERAGE_POLYGON'));
  if (!raw) return { coverage: null, errors: [] };
  try {
    return { coverage: parseCoverage(raw), errors: [] };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      coverage: null,
      errors: [
        `DELIVERY_COVERAGE_POLYGON must be a GeoJSON Polygon or MultiPolygon: ${reason}.`,
      ],
    };
  }
}

/** The configured delivery area, or null when none is. Boot has refused an invalid one. */
export function readDeliveryCoverage(
  get: (key: string) => unknown,
): DeliveryCoverage | null {
  return parseDeliveryCoverage(get).coverage;
}

/** Every delivery misconfiguration, as human-readable lines (empty = valid). */
export function collectDeliveryConfigErrors(
  env: Record<string, unknown>,
): string[] {
  const get = (key: string) => env[key];
  const { coverage, errors: coverageErrors } = parseDeliveryCoverage(get);
  const errors = [...parseDeliveryRates(get).errors, ...coverageErrors];
  // Only with an area set: without one, couriers are off on purpose and the key is not needed.
  // Refusing to boot then would take pickup and every other order down with it.
  if (
    coverage &&
    env.NODE_ENV === 'production' &&
    !asTrimmedString(env.UZMAPS_API_KEY)
  ) {
    errors.push(
      'UZMAPS_API_KEY is required in production once DELIVERY_COVERAGE_POLYGON is set: ' +
        'courier delivery cannot be priced without it.',
    );
  }
  return errors;
}

/** ConfigModule `validate` step: throws on any delivery misconfiguration. */
export function validateDeliveryEnv(
  env: Record<string, unknown>,
): Record<string, unknown> {
  const errors = collectDeliveryConfigErrors(env);
  if (errors.length > 0) {
    throw new Error(
      `Invalid delivery configuration:\n  - ${errors.join('\n  - ')}`,
    );
  }
  return env;
}
