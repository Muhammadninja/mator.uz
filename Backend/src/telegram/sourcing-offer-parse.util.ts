/**
 * Parse a seller's free-text price into whole UZS.
 *
 * Sellers type prices loosely: "250000", "250 000", "250.000", "цена 250000 сум",
 * "250к", "1.2 млн". We normalize, honour a к/k/тыс (×1000) or млн/mln (×1000000)
 * suffix, and otherwise take the digit run. Returns null when there's no usable
 * number or the value is outside a sane range, so the caller can re-prompt
 * instead of recording a junk offer.
 */
const MIN_PRICE = 100; // below this it's almost certainly not a real quote
const MAX_PRICE = 2_000_000_000; // fits a Postgres INTEGER column

export function parseOfferPrice(input: string): number | null {
  const t = (input ?? '').toLowerCase().replace(/\s+/g, '');
  if (!t) return null;

  // "250к" / "250k" / "250тыс" → ×1000 ; "1.2млн" / "1,2mln" → ×1_000_000.
  const suffix = t.match(/(\d+(?:[.,]\d+)?)(млн|mln|к|k|тыс)/);
  if (suffix) {
    const n = parseFloat(suffix[1].replace(',', '.'));
    if (!Number.isFinite(n)) return null;
    const mult = /млн|mln/.test(suffix[2]) ? 1_000_000 : 1_000;
    return clamp(Math.round(n * mult));
  }

  // Plain digit run (drops thousands separators like spaces/dots/commas).
  const digits = t.replace(/[^\d]/g, '');
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? clamp(n) : null;
}

function clamp(n: number): number | null {
  return n >= MIN_PRICE && n <= MAX_PRICE ? n : null;
}
