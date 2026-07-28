// src/telegram/motor-oil-catalog.ts
//
// SINGLE SOURCE OF TRUTH for the motor-oil questionnaire's button options:
// viscosity grades, oil types and package volumes, in display order.
//
// Every option is index-addressed by the wizard's callback payloads (see
// product-wizard.ts), so reordering or editing these arrays changes what an
// already-sent button resolves to — exactly like WIZARD_BRANDS. Bump
// CATALOG_VERSION when you touch them, and the pre-existing buttons stop
// matching instead of resolving to the wrong option.
//
// Labels are Russian (the bot speaks Russian); stored VALUES are English enum
// members / numbers, so the database never holds display text.
//
// How a STORED value is rendered back to a human (oil-type labels, volume
// formatting) is domain vocabulary shared with the buyer catalog, so it lives in
// common/motor-oil.util.ts; this file owns only what is specific to the wizard's
// UI — which options get a button, and how typed input is parsed.

import { OilType } from '@prisma/client';
import { OIL_TYPE_LABELS, formatVolume } from '../common/motor-oil.util';

export { OIL_TYPE_LABELS, formatVolume };

/**
 * One selectable option: what the seller sees, and what gets stored. `value`
 * being null marks the "Другое" escape hatch — the seller then types the value
 * as free text instead of picking a preset.
 */
export interface OilOption<T> {
  label: string;
  value: T;
}

// ── Viscosity (SAE grade) ───────────────────────────────────────────────────
// Stored verbatim as the label, since the grade IS its display form ("5W-30").
// The trailing "Другое" lets a seller enter a grade not listed here (0W-16,
// 20W-50, …) without us having to enumerate every grade on the market.
export const OIL_VISCOSITIES: string[] = [
  '0W-20',
  '0W-30',
  '0W-40',
  '5W-20',
  '5W-30',
  '5W-40',
  '10W-30',
  '10W-40',
  '15W-40',
];

/** Free-text viscosity accepted from the "Другое" branch: "0W-16", "20W-50", …
 *  Deliberately narrow — a viscosity is a SAE grade, not arbitrary prose. */
export const OIL_VISCOSITY_RE = /^\d{1,2}W-?\d{1,2}$/i;
/** Column cap: Product.oilViscosity / ProductDraft.oilViscosity are VarChar(20). */
export const OIL_VISCOSITY_MAX = 20;

/**
 * Normalize a typed viscosity to the catalog's display form: uppercase the W and
 * insert the dash when omitted ("5w30" → "5W-30"), so a typed value is stored
 * identically to the same grade picked from a button.
 */
export function normalizeViscosity(raw: string): string | null {
  const compact = raw.replace(/\s+/g, '').toUpperCase();
  if (!OIL_VISCOSITY_RE.test(compact)) return null;
  const normalized = compact.includes('-')
    ? compact
    : compact.replace(/W/, 'W-');
  return normalized.length <= OIL_VISCOSITY_MAX ? normalized : null;
}

// ── Oil type (base composition) ─────────────────────────────────────────────
// Button order; the labels themselves come from the shared vocabulary, so the
// wizard and the buyer catalog can never disagree about what a type is called.
export const OIL_TYPES: OilOption<OilType>[] = [
  OilType.SYNTHETIC,
  OilType.SEMI_SYNTHETIC,
  OilType.MINERAL,
].map((value) => ({ value, label: OIL_TYPE_LABELS[value] }));

// ── Package volume ──────────────────────────────────────────────────────────
// Stored in MILLILITRES so volumes sort and filter numerically; labels come from
// the shared formatter, so a button reads exactly as that volume will read
// everywhere else. "Другое" accepts a typed volume in litres.
export const OIL_VOLUMES: OilOption<number>[] = [
  1_000, 4_000, 5_000, 20_000,
].map((value) => ({ value, label: formatVolume(value) }));

/** Largest volume accepted from the "Другое" branch (a 200 л barrel). */
export const OIL_VOLUME_MAX_ML = 200_000;

/**
 * Parse a typed volume in LITRES into millilitres: "3", "3 л", "3.5", "0,5 l".
 * Returns null for anything non-positive, over {@link OIL_VOLUME_MAX_ML}, or
 * finer than a millilitre. Accepts both decimal separators (Russian keyboards
 * produce commas) and ignores a trailing unit.
 */
export function parseVolumeLitres(raw: string): number | null {
  // Strip the unit FIRST, then normalize the decimal separator: doing it the
  // other way round would leave a stripped unit's leftovers in the number. The
  // Cyrillic suffixes are spelled out rather than matched with `\w`, which under
  // the /u flag covers ASCII only and so would never match "литров".
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/\s*(литр(?:а|ов|ы)?|liters?|litres?|л|l)\s*$/u, '')
    .replace(/[.,]/, '.')
    .trim();
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const litres = Number(cleaned);
  if (!Number.isFinite(litres) || litres <= 0) return null;
  const ml = Math.round(litres * 1000);
  // Reject a value that rounded away to nothing (e.g. "0.0001").
  if (ml <= 0 || ml > OIL_VOLUME_MAX_ML) return null;
  return ml;
}
