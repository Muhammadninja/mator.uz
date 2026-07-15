// src/ai/part-sanitizer.ts
//
// Final normalization layer. Runs after BOTH the rule-based parser and the
// AI fallback, so the output is always consistent regardless of source:
//   - strip any leftover brand/model tokens from the title
//   - move condition/quantity words out of the title into description
//   - drop junk tokens, collapse whitespace
//   - canonicalize brand/models via the local catalog
//   - coerce gm_number to a digit string, price to number|null
//   - never keep an empty or meaningless title

import type { ParsedPartMetadata } from './part-parser.types';
import {
  canonicalizeBrand,
  deriveVehicleCompatibility,
  matchCatalog,
} from './vehicle-catalog';

// Words that describe condition/quantity/side — they belong in description,
// never in the title.
export const CONDITION_WORDS = [
  'оригинал',
  'оригинальный',
  'оригинальная',
  'новый',
  'новая',
  'новое',
  'новые',
  'б/у',
  'бу',
  'комплект',
  'правая сторона',
  'левая сторона',
  'передняя сторона',
  'задняя сторона',
  'правый',
  'левый',
  'правая',
  'левая',
  'передний',
  'задний',
  'передняя',
  'задняя',
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-boundary regex that also works for cyrillic (JS \b is latin-only).
function wordRegex(word: string, flags = 'gi'): RegExp {
  const body = escapeRegExp(word).replace(/\s+/g, '\\s+');
  return new RegExp(
    `(^|[^a-zA-Zа-яёА-ЯЁ0-9])(${body})(?=[^a-zA-Zа-яёА-ЯЁ0-9]|$)`,
    flags,
  );
}

function collapse(text: string): string {
  return text
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;.()\-–—]+/, '')
    .replace(/[\s,;.()\-–—]+$/, '')
    .trim();
}

// A title is "meaningful" if, after cleanup, it has at least one real word
// of letters (≥3 chars) and isn't just punctuation/noise.
function isMeaningfulTitle(title: string): boolean {
  const cleaned = title.trim();
  if (cleaned.length < 3) return false;
  // At least one alphabetic run of length ≥ 3 (latin or cyrillic).
  return /[a-zа-яё]{3,}/i.test(cleaned);
}

function capitalize(text: string): string {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Sanitize a parsed metadata object into the canonical, separated form.
 * Idempotent: running it twice yields the same result.
 *
 * TITLE INVARIANT: the seller's title is the source of truth. This function
 * never rewrites, shortens, or reconstructs the title — it only normalizes
 * whitespace. Brand/model are DETECTED from the title to populate the
 * structured fields, but the title text itself is left exactly as the seller
 * wrote it (whitespace aside). This holds for every source (structured,
 * rule-based, AI).
 */
export function sanitizeMetadata(input: ParsedPartMetadata): ParsedPartMetadata {
  // ── price → number|null ───────────────────────────────────────────────────
  const price =
    typeof input.price === 'number' && Number.isFinite(input.price) && input.price > 0
      ? input.price
      : null;

  // ── gm_number → digit string|null ─────────────────────────────────────────
  let gm_number: string | null = null;
  if (input.gm_number != null) {
    const digits = String(input.gm_number).replace(/\D/g, '');
    gm_number = digits.length >= 4 ? digits : null;
  }

  // ── vehicle compatibility (TEXT ONLY — no inference) ───────────────────────
  // Make/model may come from exactly two sources: (a) the listing TEXT (handled
  // here + in the title pass below), or (b) the verified internal OEM database
  // (merged by the caller AFTER sanitizing — see PartParserService). We must
  // NEVER trust a brand/model that an upstream layer inferred but that does not
  // appear in the text: the AI fallback can hallucinate a vehicle from an OEM
  // number, so its `brand`/`models` are deliberately IGNORED here. They are only
  // honored if `matchCatalog` independently finds them in the title/description.
  //
  // Structured/rule-based results already carry line-aware `vehicles`/
  // `isUniversal` derived from their own text; pass those through unchanged.
  let brand: string | null = canonicalizeBrand(input.brand ?? null);
  let models: string[] = [];
  let isUniversal = input.isUniversal ?? false;
  let vehicles = input.vehicles ?? [];
  if (input.vehicles === undefined) {
    // AI / legacy path: derive purely from the listing text. No `extra` bridge —
    // the AI's own brand/models are NOT fed in, so an OEM-hallucinated vehicle
    // cannot survive unless the text actually names it.
    const compat = deriveVehicleCompatibility([input.title, input.description]);
    isUniversal = compat.isUniversal;
    vehicles = compat.vehicles;
    brand = compat.brand;
    models = compat.models;
  } else {
    // Structured/rule-based: models/brand already reflect the text.
    models = [...new Set(vehicles.map((v) => v.model))];
    if (!brand) brand = vehicles.find((v) => v.brand)?.brand ?? null;
  }
  if (isUniversal) {
    // Universal fitment suppresses every per-vehicle field.
    brand = null;
    models = [];
    vehicles = [];
  }

  const descriptionParts: string[] = [];
  if (input.description && input.description.trim()) {
    descriptionParts.push(input.description.trim());
  }

  // ── title (INVARIANT: preserve verbatim, whitespace-normalize only) ────────
  let title = input.title ? input.title.trim() : '';

  if (title) {
    // DETECT brand/model in the title to populate the structured fields. This
    // only reads the title — the tokens stay in the title text unchanged.
    // Skipped for universal parts: nothing per-vehicle may survive on them.
    if (!isUniversal) {
      const catalogHit = matchCatalog(title);
      if (!brand && catalogHit.brand) brand = catalogHit.brand;
      for (const v of catalogHit.vehicles) {
        if (!models.includes(v.model)) {
          models.push(v.model);
          if (!vehicles.some((x) => x.brand === v.brand && x.model === v.model)) {
            vehicles = [...vehicles, v];
          }
        }
      }
    }

    // The ONLY transform applied to the title: collapse whitespace. No word
    // removal, no rewriting, no capitalization (the seller's casing stands).
    title = collapse(title);
  }

  // Reject empty/meaningless titles (does not modify a valid title).
  const finalTitle = title && isMeaningfulTitle(title) ? title : null;

  // ── assemble description ──────────────────────────────────────────────────
  const seen = new Set<string>();
  const dedupParts = descriptionParts
    .map((p) => collapse(p))
    .filter((p) => {
      const key = p.toLowerCase();
      if (!p || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const description = dedupParts.length ? capitalize(dedupParts.join(', ')) : null;

  return {
    title: finalTitle,
    description,
    brand: brand && brand.trim() ? brand.trim() : null,
    models,
    vehicles,
    isUniversal,
    gm_number,
    // Preserve the seller-labeled type as-is; the sanitizer never re-classifies
    // a number (that would risk guessing GM/OEM from the digits).
    part_number_type: input.part_number_type,
    price,
  };
}
