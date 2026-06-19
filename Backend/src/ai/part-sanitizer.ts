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
  canonicalizeModel,
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

  // ── brand/models → canonical, from catalog ────────────────────────────────
  let brand = canonicalizeBrand(input.brand);
  const models = Array.isArray(input.models)
    ? [...new Set(input.models.map((m) => canonicalizeModel(String(m).trim())).filter(Boolean))]
    : [];

  const descriptionParts: string[] = [];
  if (input.description && input.description.trim()) {
    descriptionParts.push(input.description.trim());
  }

  // ── title cleanup ─────────────────────────────────────────────────────────
  let title = input.title ? input.title.trim() : '';

  if (title) {
    // 1. Strip brand/model tokens the AI/rule-parser may have left in the title.
    const catalogHit = matchCatalog(title);
    if (!brand && catalogHit.brand) brand = catalogHit.brand;
    for (const m of catalogHit.models) {
      if (!models.includes(m)) models.push(m);
    }
    for (const token of catalogHit.matchedTokens) {
      title = title.replace(wordRegex(token), ' ');
    }

    // 2. Strip any OEM number / price digits that leaked into the title.
    title = title.replace(/\b\d{4,}\b/g, ' ');
    title = title.replace(/(uzs|сум|сўм|so'm|som)/gi, ' ');

    // 3. Move condition words from title → description.
    for (const word of CONDITION_WORDS) {
      const re = wordRegex(word);
      const matches = title.match(re);
      if (matches) {
        for (const raw of matches) {
          const clean = collapse(raw);
          if (clean) descriptionParts.push(clean);
        }
        title = title.replace(re, ' ');
      }
    }

    title = collapse(title);
  }

  // 4. Reject empty/meaningless titles.
  const finalTitle = title && isMeaningfulTitle(title) ? capitalize(title) : null;

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
    gm_number,
    price,
  };
}
