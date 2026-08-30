// src/telegram/antifreeze-catalog.ts
//
// SINGLE SOURCE OF TRUTH for the antifreeze questionnaire's button options: the
// package weights, in display order.
//
// Every option is index-addressed by the wizard's callback payloads (see
// product-wizard.ts), exactly like the motor-oil catalogs — so reordering or
// editing this array changes what an already-sent button resolves to. Bump
// CATALOG_VERSION when you touch it and the pre-existing buttons stop matching
// instead of resolving to the wrong option.
//
// WHY WEIGHT AND NOT PIECES. Antifreeze is sold BY THE KILOGRAM. A listing
// therefore carries a packaged NET WEIGHT, never a "штук" count — the rule is
// declared once on the kind (KIND_CAPABILITIES[ANTIFREEZE].unit === 'KG') and
// this file is what collects the value.
//
// How a STORED weight is rendered back to a human lives in
// common/antifreeze.util.ts, shared with the buyer catalog; this file owns only
// what is specific to the wizard's UI.

import { formatWeight } from '../common/antifreeze.util';

export { formatWeight };

/** One selectable weight: what the seller sees, and the grams that get stored. */
export interface WeightOption {
  label: string;
  value: number;
}

// ── Package weight ──────────────────────────────────────────────────────────
// Stored in GRAMS so weights sort and filter numerically and fractional
// kilograms are exact; labels come from the shared formatter, so a button reads
// exactly as that weight will read everywhere else. "Другое" accepts a typed
// weight in kilograms.
export const ANTIFREEZE_WEIGHTS: WeightOption[] = [
  1_000, 2_500, 5_000, 10_000,
].map((value) => ({ value, label: formatWeight(value) }));

/** Largest weight accepted from the "Другое" branch (a 220 кг barrel). */
export const ANTIFREEZE_WEIGHT_MAX_G = 220_000;

/**
 * Parse a typed weight in KILOGRAMS into grams: "1", "2.5", "2,5 кг", "10 kg".
 * Returns null for anything non-positive, over {@link ANTIFREEZE_WEIGHT_MAX_G},
 * or finer than a gram.
 *
 * Deliberately the same shape as `parseVolumeLitres`: the unit suffix is
 * stripped FIRST (so its leftovers cannot pollute the number), then the decimal
 * separator is normalized — Russian keyboards produce commas, and FRACTIONAL
 * input is the whole point here ("2.5 кг").
 */
export function parseWeightKg(raw: string): number | null {
  const cleaned = raw
    .trim()
    .toLowerCase()
    // Cyrillic suffixes are spelled out rather than matched with `\w`, which
    // under the /u flag covers ASCII only and so would never match "килограмм".
    .replace(/\s*(килограмм(?:а|ов)?|kilograms?|кг|kg)\s*$/u, '')
    .replace(/[.,]/, '.')
    .trim();
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const kg = Number(cleaned);
  if (!Number.isFinite(kg) || kg <= 0) return null;
  const grams = Math.round(kg * 1000);
  // Reject a value that rounded away to nothing (e.g. "0.0001").
  if (grams <= 0 || grams > ANTIFREEZE_WEIGHT_MAX_G) return null;
  return grams;
}
