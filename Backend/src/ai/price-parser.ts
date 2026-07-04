// src/ai/price-parser.ts
//
// Single source of truth for turning a human-written price string into a numeric
// UZS value. Sellers write prices inconsistently, and the same character (".")
// means different things depending on context:
//
//   • THOUSANDS separator — "130.000" = 130000, "1.250.000" = 1250000
//   • DECIMAL separator    — "130.50"  = 130.5,  "99.99"     = 99.99
//
// The rule we use (matches how UZS prices are actually written locally):
//
//   1. A dot/comma/space that groups the number into 3-digit runs is a THOUSANDS
//      separator (integer group pattern: 1–3 digits, then any number of ".ddd" /
//      ",ddd" / " ddd" groups). Such separators are removed and the whole thing
//      is one integer. "130.000", "1.250.000", "130 000", "1 250 000", "130,000".
//   2. Otherwise, a SINGLE dot (or comma) followed by EXACTLY 1–2 digits is a
//      DECIMAL separator. "130.00" → 130, "130.50" → 130.5, "99.99" → 99.99.
//   3. Currency names/symbols (сум, so'm, UZS, $, у.е., …) and surrounding
//      whitespace are ignored.
//
// Ambiguity note: "130.000" is treated as thousands (→130000) because that is
// the dominant local convention for whole-sum prices; a genuine decimal is only
// ever written with ONE or TWO fractional digits ("130.50", "99.99"), never
// three. This is exactly the behavior the catalog requires.
//
// Whole values are returned as integers (Number keeps no ".0"); genuine decimals
// keep their fractional part ("130.50" → 130.5). Returns null when the input has
// no parseable number or the value is not > 0.

/** Currency words/symbols we strip before parsing. Matched case-insensitively. */
const CURRENCY_RE = /\b(uzs|сум|сўм|so'?m|som|usd|rub|у\.?\s?е\.?)\b|[$₽]/gi;

/** A run of digits grouped into thousands by ".", ",", or " " — e.g.
 *  "130.000", "1.250.000", "130 000", "130,000". The first group is 1–3 digits;
 *  every subsequent group is a separator followed by EXACTLY 3 digits. */
const THOUSANDS_GROUPED_RE = /^\d{1,3}(?:[.,\s]\d{3})+$/;

/** A plain decimal: integer part, a "." or "," and 1–2 fractional digits. */
const DECIMAL_RE = /^(\d+)[.,](\d{1,2})$/;

/** A bare run of digits (no separators). */
const PLAIN_INT_RE = /^\d+$/;

/**
 * Parse a price string to a number, applying the thousands-vs-decimal rules
 * above. Returns null when nothing numeric is present or the value is ≤ 0.
 *
 * Examples (see price-parser.spec.ts for the full matrix):
 *   parsePrice("130.000 сум") === 130000
 *   parsePrice("1.250.000")   === 1250000
 *   parsePrice("130 000")     === 130000
 *   parsePrice("130,000")     === 130000
 *   parsePrice("130.00")      === 130
 *   parsePrice("130.50")      === 130.5
 *   parsePrice("99.99")       === 99.99
 */
export function parsePrice(input: string): number | null {
  if (typeof input !== 'string') return null;

  // 1. Drop currency markers, then collapse whitespace to isolate the number.
  //    We keep internal single spaces for the moment (they may be thousands
  //    separators like "130 000") and trim the ends.
  const cleaned = input
    .replace(CURRENCY_RE, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
  if (!cleaned) return null;

  // 2. Isolate the numeric token: leading number optionally containing spaces /
  //    dots / commas as separators. Everything else (stray letters) is ignored.
  const m = cleaned.match(/\d[\d.,\s]*\d|\d/);
  if (!m) return null;
  const token = m[0].trim();

  // Reject an explicitly negative amount ("-5"): a price is never negative, and
  // a leading "-" right before the token signals bad input rather than a value.
  if (m.index !== undefined && m.index > 0 && cleaned[m.index - 1] === '-') return null;

  // 3. THOUSANDS-grouped (with "." / "," / " ") → strip the separators, integer.
  if (THOUSANDS_GROUPED_RE.test(token)) {
    return toPositive(parseInt(token.replace(/[.,\s]/g, ''), 10));
  }

  // 4. A space-separated group that is NOT a clean 3-digit grouping (rare, e.g.
  //    "130 00") — treat spaces as thousands separators too: drop them and parse
  //    the remainder by the same rules (so "1 250 000" already matched step 3,
  //    but "130 000,50" would fall through here to keep the decimal).
  if (/\s/.test(token)) {
    const noSpaces = token.replace(/\s/g, '');
    if (noSpaces !== token) return parseNumericToken(noSpaces);
  }

  return parseNumericToken(token);
}

/** Parse a separator-bearing token with NO spaces: decimal, thousands, or int. */
function parseNumericToken(token: string): number | null {
  // Thousands grouping without spaces ("130.000", "1.250.000", "130,000").
  if (THOUSANDS_GROUPED_RE.test(token)) {
    return toPositive(parseInt(token.replace(/[.,]/g, ''), 10));
  }

  // Genuine decimal: integer part + 1–2 fractional digits ("130.50", "99.99").
  const dec = token.match(DECIMAL_RE);
  if (dec) {
    const value = Number(`${dec[1]}.${dec[2]}`);
    return toPositive(value);
  }

  // Plain integer.
  if (PLAIN_INT_RE.test(token)) {
    return toPositive(parseInt(token, 10));
  }

  // Anything left with mixed separators that didn't match a clean pattern
  // (e.g. "1.250.00" — three groups but last is 2 digits): fall back to
  // stripping grouping separators and treating any final 1–2 digit tail after
  // the LAST dot/comma as decimals is ambiguous; we conservatively drop all
  // separators and treat as an integer so we never lose thousands.
  const digitsOnly = token.replace(/[.,]/g, '');
  if (PLAIN_INT_RE.test(digitsOnly)) {
    return toPositive(parseInt(digitsOnly, 10));
  }

  return null;
}

/** Normalize a whole-valued float to an integer; reject non-finite / ≤ 0. */
function toPositive(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  // Store whole UZS prices as integers whenever possible (130.00 → 130).
  return Number.isInteger(value) ? value : value;
}
