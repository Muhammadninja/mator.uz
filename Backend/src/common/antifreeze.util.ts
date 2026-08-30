// src/common/antifreeze.util.ts
//
// Shared ANTIFREEZE vocabulary: how a stored net weight is rendered for a human.
// Lives in common/ for exactly the reason motor-oil.util.ts does — BOTH the
// seller bot's preview caption and the buyer-facing catalog API render it, and
// the buyer catalog must not import from the bot.
//
// The bot's questionnaire options (which weights get their own button) and its
// free-text parser stay in src/telegram/antifreeze-catalog.ts: those are
// properties of the wizard's UI, not of the domain.

/** Weights that render with a fixed label, keyed by GRAMS. */
const WEIGHT_LABELS = new Map<number, string>([
  [1_000, '1 кг'],
  [2_500, '2.5 кг'],
  [5_000, '5 кг'],
  [10_000, '10 кг'],
]);

/**
 * Display label for a stored net weight in GRAMS: a common package size renders
 * as its familiar label ("2.5 кг"), a sub-kilogram one in grams ("500 г"), and
 * anything else in kilograms with trailing zeros trimmed ("3.2 кг").
 *
 * Mirrors {@link ../common/motor-oil.util.formatVolume} deliberately: the two
 * kinds differ in the unit they are sold in, not in how a package size reads.
 */
export function formatWeight(g: number): string {
  const known = WEIGHT_LABELS.get(g);
  if (known) return known;
  if (g < 1000) return `${g} г`;
  return `${Number((g / 1000).toFixed(3))} кг`;
}
