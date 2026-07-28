// src/common/motor-oil.util.ts
//
// Shared MOTOR-OIL vocabulary: how a stored oil attribute is rendered for a
// human. Lives in common/ rather than in the Telegram module because BOTH sides
// of the system need it — the seller bot's preview caption and the buyer-facing
// catalog API — and the buyer catalog must not import from the bot.
//
// The bot's questionnaire options (which grades/volumes get their own button)
// and its free-text input parsers stay in src/telegram/motor-oil-catalog.ts:
// those are properties of the wizard's UI, not of the domain.

import { OilType } from '@prisma/client';

/** Russian display label per stored OilType. Exhaustive by construction: a new
 *  enum member fails to compile until its label is added. */
export const OIL_TYPE_LABELS: Record<OilType, string> = {
  [OilType.SYNTHETIC]: 'Синтетическое',
  [OilType.SEMI_SYNTHETIC]: 'Полусинтетическое',
  [OilType.MINERAL]: 'Минеральное',
};

/** Volumes that render with a fixed label, keyed by millilitres. */
const VOLUME_LABELS = new Map<number, string>([
  [1_000, '1 л'],
  [4_000, '4 л'],
  [5_000, '5 л'],
  [20_000, '20 л'],
]);

/**
 * Display label for a stored volume in millilitres: a common package size
 * renders as its familiar label ("4 л"), a sub-litre one in millilitres
 * ("500 мл"), and anything else in litres with trailing zeros trimmed
 * ("3.5 л").
 */
export function formatVolume(ml: number): string {
  const known = VOLUME_LABELS.get(ml);
  if (known) return known;
  if (ml < 1000) return `${ml} мл`;
  return `${Number((ml / 1000).toFixed(3))} л`;
}
