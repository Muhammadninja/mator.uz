/**
 * Exact numbers from the 1C export, and the ONE rule that turns a Driver's
 * Village source price into the Mator price. Pure: no I/O, no database.
 */
import { Prisma } from '@prisma/client';
import {
  MAX_PRICE_UZS,
  PRICE_IN_THOUSANDS_BELOW,
  PRICE_THOUSANDS_FACTOR,
} from './drivers-village.constants';

/** Spaces 1C/Excel use as thousands separators (regular, NBSP, thin, narrow). */
const GROUP_SEPARATORS = /[ \u00a0\u2009\u202f]/g;

/** Decimal places stocks.price_uzs holds (DECIMAL(14,2), tiyin). */
const PRICE_SCALE = 2;

/** How many places ×PRICE_THOUSANDS_FACTOR moves the decimal point. */
const THOUSANDS_SHIFT = Math.log10(PRICE_THOUSANDS_FACTOR);

export type DecimalResult =
  { ok: true; value: Prisma.Decimal } | { ok: false; reason: string };

/**
 * How an export writes numbers. It follows from the export's format (the
 * delimiter), never from the value — a number is read one way only:
 *   • 'decimal-comma'   — Excel's tab-delimited text (ru locale): "1 060 387,74";
 *                         spaces group thousands, the comma (or a dot) is the
 *                         decimal separator.
 *   • 'thousands-comma' — 1C's ";"-delimited export: "1,060,387.74"; commas
 *                         group thousands strictly in threes, the dot is the
 *                         decimal separator (every dv_parts export so far:
 *                         prices "1,100,000", quantities "2,268" and "12.5").
 */
export type NumberFormat = 'decimal-comma' | 'thousands-comma';

/** 1,234,567.89 — the first group without a leading zero, then threes. */
const THOUSANDS_COMMA = /^(?:[1-9]\d{0,2}(?:,\d{3})+|\d+)(?:\.(\d+))?$/;

/**
 * Parse an export number exactly — never through a float — in the export's
 * NumberFormat. Anything that does not fit is rejected, not guessed: in
 * 'decimal-comma' a second separator ("1,600,000") is ambiguous between a
 * decimal and a thousands comma; in 'thousands-comma' a comma that does not
 * start a group of three ("12,34", "1,5") could be a decimal comma.
 * `maxFraction` caps the decimal places; omitted, the caller checks the
 * precision itself.
 */
export function parseDecimal(
  raw: string,
  maxFraction?: number,
  format: NumberFormat = 'decimal-comma',
): DecimalResult {
  if (format === 'thousands-comma') {
    const value = raw.trim();
    if (!value) return { ok: false, reason: 'empty' };
    if (value.startsWith('-')) return { ok: false, reason: 'negative' };
    const m = THOUSANDS_COMMA.exec(value);
    if (!m)
      return {
        ok: false,
        reason:
          'not a number in the export’s 1,234.56 format (commas group thousands in threes, a dot separates decimals)',
      };
    if (maxFraction !== undefined && (m[1]?.length ?? 0) > maxFraction)
      return { ok: false, reason: `more than ${maxFraction} decimal places` };
    return { ok: true, value: new Prisma.Decimal(value.replace(/,/g, '')) };
  }
  const compact = raw.trim().replace(GROUP_SEPARATORS, '');
  if (!compact) return { ok: false, reason: 'empty' };
  if (compact.startsWith('-')) return { ok: false, reason: 'negative' };
  if ((compact.match(/[,.]/g) ?? []).length > 1)
    return { ok: false, reason: 'more than one decimal separator' };
  const normalized = compact.replace(',', '.');
  const m = /^(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!m) return { ok: false, reason: 'not a plain non-negative number' };
  if (maxFraction !== undefined && (m[2]?.length ?? 0) > maxFraction)
    return { ok: false, reason: `more than ${maxFraction} decimal places` };
  return { ok: true, value: new Prisma.Decimal(normalized) };
}

export type SourcePrice =
  | {
      ok: true;
      /** The Mator price in UZS: a canonical 2-decimal string, never a float. */
      priceUzs: string;
      /** True when the source was below 1000 (thousands) and was ×1000. */
      scaled: boolean;
    }
  | { ok: false; reason: string };

/**
 * The Driver's Village price rule (business decision, 2026-10-15): 1C writes
 * some prices in thousands of UZS. A source price strictly below 1000 is in
 * thousands and is multiplied by 1000; from 1000 up it is UZS and is kept.
 *
 *   690 → 690000 · 6,5 → 6500 · 320,65 → 320650 · 530,560 → 530560
 *   999,999 → 999999 · 1000 → 1000 · 12500 → 12500
 *
 * Applied to the SOURCE cell of every export, exactly once, while the row is
 * parsed — never to a price already stored in Mator. The same cell therefore
 * always yields the same price, so re-importing a file cannot scale twice.
 * The rule works on the number the cell holds in the export's NumberFormat:
 * "1,100,000" in the ";" export is 1100000 UZS (≥ 1000, kept), "140" is
 * 140000.
 *
 * Nothing is rounded. The result must fit stocks.price_uzs (2 decimals) as it
 * is: a price in thousands may carry up to 5 decimals (×1000 shifts 3 of them
 * into the integer part), a price in UZS up to 2. Anything else — empty, zero,
 * negative, malformed, too precise, too large — is a reason, not a value.
 */
export function normalizeSourcePrice(
  raw: string,
  format: NumberFormat = 'decimal-comma',
): SourcePrice {
  // No cap while parsing: how many decimals fit depends on the scale.
  const parsed = parseDecimal(raw, undefined, format);
  if (!parsed.ok) return parsed;
  const source = parsed.value;
  if (source.isZero()) return { ok: false, reason: 'must be greater than 0' };

  const scaled = source.lt(PRICE_IN_THOUSANDS_BELOW);
  // Checked on the SOURCE, before multiplying: the operands then have at most
  // 8 significant digits, so Decimal's 20-digit arithmetic is exact.
  if (source.decimalPlaces() > PRICE_SCALE + (scaled ? THOUSANDS_SHIFT : 0)) {
    return {
      ok: false,
      reason: scaled
        ? `below ${PRICE_IN_THOUSANDS_BELOW}, so in thousands of UZS, but ×${PRICE_THOUSANDS_FACTOR} would still leave more than ${PRICE_SCALE} decimal places (never rounded)`
        : `more than ${PRICE_SCALE} decimal places (price_uzs holds tiyin; never rounded)`,
    };
  }
  const price = scaled ? source.times(PRICE_THOUSANDS_FACTOR) : source;
  if (price.gt(MAX_PRICE_UZS))
    return { ok: false, reason: 'exceeds 999 999 999 999.99 UZS' };
  return { ok: true, priceUzs: price.toFixed(PRICE_SCALE), scaled };
}
