// src/ai/rule-based-parser.ts
//
// Step 1 of the hybrid pipeline: extract structured fields from seller text
// using regexes + the local vehicle catalog only (no AI, no network).
// Returns a confidence score so the orchestrator can decide whether to accept
// the result or fall back to AI.

import type { RuleBasedResult } from './part-parser.types';
import { CONDITION_WORDS } from './part-sanitizer';
import { parsePrice } from './price-parser';
import { splitParagraphs } from './structured-parser';
import { matchCatalog } from './vehicle-catalog';

// ── Confidence weights (tweak the parser's behavior from one place) ──────────
export const CONFIDENCE_WEIGHTS = {
  gmNumber: 0.35,
  price: 0.25,
  brandOrModel: 0.25,
  goodTitle: 0.15,
} as const;

/** Threshold at/above which the rule-based result is accepted without AI. */
export const RULE_CONFIDENCE_THRESHOLD = 0.7;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wordRegex(word: string, flags = 'gi'): RegExp {
  const body = escapeRegExp(word).replace(/\s+/g, '\\s+');
  return new RegExp(
    `(^|[^a-zA-Zа-яёА-ЯЁ0-9])(${body})(?=[^a-zA-Zа-яёА-ЯЁ0-9]|$)`,
    flags,
  );
}

// ── Normalization ────────────────────────────────────────────────────────────
/** lower-trim-collapse, normalize separators. Used for matching, not display. */
export function normalizeText(raw: string): string {
  return raw
    .replace(/[ \t\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── Field extractors ──────────────────────────────────────────────────────────

interface PriceHit {
  value: number | null;
  /** substring(s) to remove from the text before building the title. */
  raw: string[];
}

// Price: a number explicitly followed by a currency word is strongest. Falls
// back to the largest "big" bare number (> 1000) which is almost always a price.
function extractPrice(text: string): PriceHit {
  const raw: string[] = [];

  // Price = a digit run immediately before a currency word. The number may use
  // "." / "," thousands separators AND spaces between 3-digit groups (so
  // "130 000 сум" is caught), but a group after a space must be exactly 3 digits
  // — this keeps a separate preceding number (e.g. an OEM code) from bleeding in.
  // The matched string is parsed by the shared parsePrice, so "130.000" → 130000
  // (thousands) while "130.00" → 130 (decimal).
  const currencyRe = /(\d[\d.,]*(?:\s\d{3})*(?:[.,]\d{1,2})?)\s*(uzs|сум|сўм|so'm|som|usd|\$|у\.е\.?)/gi;
  let best: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = currencyRe.exec(text)) !== null) {
    const n = parsePrice(m[1]);
    if (n !== null) {
      best = best === null ? n : Math.max(best, n);
      raw.push(m[0]);
    }
  }
  if (best !== null) return { value: best, raw };

  // No currency marker — take the largest number > 1000 that isn't a long
  // OEM-looking code (OEM is handled separately and removed first by caller).
  // Also accept dot/comma/space-grouped numbers here (e.g. "130.000" with no
  // currency word) via parsePrice, so a thousands-grouped price is not missed.
  const groupedRe = /\b\d{1,3}(?:[.,\s]\d{3})+\b|\b\d{4,7}\b/g;
  const candidates: number[] = [];
  const rawByValue = new Map<number, string>();
  for (const match of text.matchAll(groupedRe)) {
    const value = parsePrice(match[0]);
    if (value !== null && value > 1000) {
      candidates.push(value);
      if (!rawByValue.has(value)) rawByValue.set(value, match[0]);
    }
  }
  if (candidates.length) {
    const value = Math.max(...candidates);
    return { value, raw: [rawByValue.get(value) ?? String(value)] };
  }

  return { value: null, raw: [] };
}

interface GmHit {
  value: string | null;
  raw: string[];
}

// OEM/GM number: 5–11 digit run, optionally with letters (some OEMs have a
// trailing letter). We keep digits only for storage. Exclude pure price-like
// short numbers by requiring ≥5 digits.
function extractGmNumber(textWithoutPrice: string): GmHit {
  // Allow optional letters around a long digit core, e.g. "96535062", "GM96535062".
  const re = /\b([A-Za-z]{0,3}\d{5,11}[A-Za-z]{0,2})\b/;
  const m = textWithoutPrice.match(re);
  if (!m) return { value: null, raw: [] };
  const digits = m[1].replace(/\D/g, '');
  if (digits.length < 5) return { value: null, raw: [] };
  return { value: digits, raw: [m[0]] };
}

// ── Title preservation (the invariant) ────────────────────────────────────────
/**
 * The ONLY transform allowed on a title, on every parser path: trim and collapse
 * duplicate internal whitespace. No word removal, no rewriting. Returns null for
 * an empty/whitespace-only input.
 */
export function normalizeTitle(raw: string): string | null {
  const t = raw.replace(/[ \t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return t.length ? t : null;
}

/**
 * DETECT condition words in the text for the description. This reads the text
 * and returns the matched condition phrases — it does NOT modify its input (and
 * therefore never touches the title). Returns null when none are found.
 */
function extractConditionWords(text: string): string | null {
  const found: string[] = [];
  for (const word of CONDITION_WORDS) {
    const matches = text.match(wordRegex(word));
    if (matches) {
      for (const raw of matches) {
        const clean = raw.replace(/[^a-zA-Zа-яёА-ЯЁ0-9/ ]/g, '').trim();
        if (clean) found.push(clean);
      }
    }
  }
  return found.length ? found.join(', ') : null;
}

// Looks like a real part name: has a cyrillic/latin word ≥3 chars and isn't
// dominated by random consonant noise.
function looksLikeGoodTitle(title: string | null): boolean {
  if (!title) return false;
  if (!/[a-zа-яё]{3,}/i.test(title)) return false;
  // Reject strings that are mostly the same repeated/garbage chars.
  const letters = title.replace(/[^a-zа-яё]/gi, '');
  if (letters.length < 3) return false;
  const vowels = (letters.match(/[aeiouауоыиэяюёе]/gi) || []).length;
  // Real words almost always contain a vowel; pure-consonant junk ("hshshdh") won't.
  return vowels > 0;
}

// ── Confidence ────────────────────────────────────────────────────────────────
export function computeConfidence(params: {
  hasGm: boolean;
  hasPrice: boolean;
  hasBrandOrModel: boolean;
  hasGoodTitle: boolean;
}): number {
  let score = 0;
  if (params.hasGm) score += CONFIDENCE_WEIGHTS.gmNumber;
  if (params.hasPrice) score += CONFIDENCE_WEIGHTS.price;
  if (params.hasBrandOrModel) score += CONFIDENCE_WEIGHTS.brandOrModel;
  if (params.hasGoodTitle) score += CONFIDENCE_WEIGHTS.goodTitle;
  return Math.min(1, Math.round(score * 100) / 100);
}

/**
 * Parse seller text with rules only. Returns canonical-ish fields plus a
 * confidence score. The orchestrator runs the shared sanitizer afterwards.
 *
 * Multi-paragraph captions (blank-line separated) are handled specially so the
 * title can never absorb later paragraphs: only the FIRST paragraph feeds title
 * extraction; the rest are description + field-detection material. A single
 * paragraph keeps the original flat behavior (backward compatible).
 */
export function ruleBasedParse(rawText: string): RuleBasedResult {
  const paragraphs = splitParagraphs(rawText);
  if (paragraphs.length >= 2) {
    return parseMultiParagraph(paragraphs);
  }
  return parseFlat(normalizeText(rawText));
}

/**
 * Single-paragraph (or unparagraphed) caption.
 *
 * INVARIANT: the seller's title is the source of truth. There is no separate
 * title field to isolate here, so the title is the WHOLE line, verbatim except
 * whitespace normalization. Brand / model / GM / price / condition are still
 * DETECTED (to populate the structured fields), but detection reads a working
 * COPY of the text and never mutates the title. The description is assembled
 * only from detected condition words — extraction, not title surgery.
 */
function parseFlat(text: string): RuleBasedResult {
  // Detection runs on a working copy; the title is preserved separately.
  const priceHit = extractPrice(text);
  let working = text;
  for (const r of priceHit.raw) {
    working = working.replace(r, ' ');
  }

  const gmHit = extractGmNumber(working);
  for (const r of gmHit.raw) {
    working = working.replace(r, ' ');
  }

  const catalog = matchCatalog(working);

  // Condition words → description (extracted, not removed from the title).
  const description = extractConditionWords(text);

  // Title = the seller's line, verbatim except whitespace normalization.
  const title = normalizeTitle(text);

  const hasBrandOrModel = Boolean(catalog.brand) || catalog.models.length > 0;
  const goodTitle = looksLikeGoodTitle(title);
  const confidence = computeConfidence({
    hasGm: Boolean(gmHit.value),
    hasPrice: priceHit.value !== null,
    hasBrandOrModel,
    hasGoodTitle: goodTitle,
  });

  return {
    title,
    description,
    brand: catalog.brand,
    models: catalog.models,
    gm_number: gmHit.value,
    price: priceHit.value,
    confidence,
    // Title is the seller's verbatim text — the sanitizer must not rewrite it.
    preserveTitle: true,
  };
}

/**
 * Multi-paragraph caption: the title comes ONLY from the first paragraph and is
 * preserved verbatim (whitespace-normalized) — the detected make/model is NOT
 * stripped from it and no text from later paragraphs can leak in. The remaining
 * paragraphs supply the description and are the source for GM/OEM and price
 * detection; the price/GM tokens are removed from the description text only.
 *
 * This is the hardening for captions like:
 *   "Магнитола для Nexia 3\n\nПроизводство Корея, новая"
 * which previously flattened to one string and produced the corrupt title
 * "Магнитола для Производство Корея".
 */
function parseMultiParagraph(paragraphs: string[]): RuleBasedResult {
  const titleParagraph = paragraphs[0];
  const restText = normalizeText(paragraphs.slice(1).join(' '));

  // Detect price / GM from the description paragraphs (not from the title, so a
  // number in the title can never be treated as price/OEM and stripped away).
  const priceHit = extractPrice(restText);
  let restWorking = restText;
  for (const r of priceHit.raw) {
    restWorking = restWorking.replace(r, ' ');
  }
  const gmHit = extractGmNumber(restWorking);
  for (const r of gmHit.raw) {
    restWorking = restWorking.replace(r, ' ');
  }

  // Detect brand/model from the FULL caption (title + rest) so a model named in
  // the title still populates the structured fields — but the title text itself
  // is left untouched (make/model stays in it, per the contract).
  const catalog = matchCatalog(`${titleParagraph} ${restText}`);

  // Title = first paragraph, verbatim except whitespace normalization.
  const title = normalizeTitle(titleParagraph);

  // Description = remaining paragraphs with price/GM tokens removed; condition
  // words are kept in place (this is the seller's own description text).
  const description = cleanDescription(restWorking);

  const hasBrandOrModel = Boolean(catalog.brand) || catalog.models.length > 0;
  const goodTitle = looksLikeGoodTitle(title);
  const confidence = computeConfidence({
    hasGm: Boolean(gmHit.value),
    hasPrice: priceHit.value !== null,
    hasBrandOrModel,
    hasGoodTitle: goodTitle,
  });

  return {
    title,
    description,
    brand: catalog.brand,
    models: catalog.models,
    gm_number: gmHit.value,
    price: priceHit.value,
    confidence,
    // Title is the seller's verbatim first paragraph — the sanitizer must keep
    // it as-is (don't strip the make/model out of it).
    preserveTitle: true,
  };
}

/** Tidy the description text: collapse whitespace, trim stray separators. */
function cleanDescription(text: string): string | null {
  const cleaned = text
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;.()\-–—]+/, '')
    .replace(/[\s,;.()\-–—]+$/, '')
    .trim();
  return cleaned.length ? cleaned : null;
}
