// src/ai/rule-based-parser.ts
//
// Step 1 of the hybrid pipeline: extract structured fields from seller text
// using regexes + the local vehicle catalog only (no AI, no network).
// Returns a confidence score so the orchestrator can decide whether to accept
// the result or fall back to AI.

import type { RuleBasedResult } from './part-parser.types';
import { CONDITION_WORDS } from './part-sanitizer';
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

  // Price = a digit run (optionally with "." / "," thousands separators, but
  // NOT spaces) immediately before a currency word. Disallowing spaces inside
  // the number keeps a separate preceding number (e.g. an OEM code) out of it.
  const currencyRe = /(\d[\d.,]*)\s*(uzs|сум|сўм|so'm|som|usd|\$|у\.е\.?)/gi;
  let best: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = currencyRe.exec(text)) !== null) {
    const n = parseInt(m[1].replace(/[.,]/g, ''), 10);
    if (Number.isFinite(n) && n > 0) {
      best = best === null ? n : Math.max(best, n);
      raw.push(m[0]);
    }
  }
  if (best !== null) return { value: best, raw };

  // No currency marker — take the largest number > 1000 that isn't a long
  // OEM-looking code (OEM is handled separately and removed first by caller).
  const numbers = [...text.matchAll(/\b(\d{4,7})\b/g)].map((x) => x[1]);
  const candidates = numbers.map(Number).filter((n) => n > 1000);
  if (candidates.length) {
    const value = Math.max(...candidates);
    return { value, raw: [String(value)] };
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

// ── Title / description split ─────────────────────────────────────────────────
// After brand/model/price/gm are removed, what remains is "title + description".
// Condition words go to description; the rest is the title.
function splitTitleAndDescription(remainder: string): {
  title: string | null;
  description: string | null;
} {
  let title = remainder;
  const descParts: string[] = [];

  for (const word of CONDITION_WORDS) {
    const re = wordRegex(word);
    const matches = title.match(re);
    if (matches) {
      for (const raw of matches) {
        const clean = raw.replace(/[^a-zA-Zа-яёА-ЯЁ0-9/ ]/g, '').trim();
        if (clean) descParts.push(clean);
      }
      title = title.replace(re, ' ');
    }
  }

  title = title
    .replace(/[^\p{L}\p{N}\s/-]+/gu, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return {
    title: title.length >= 3 ? title : null,
    description: descParts.length ? descParts.join(', ') : null,
  };
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
 */
export function ruleBasedParse(rawText: string): RuleBasedResult {
  const text = normalizeText(rawText);

  // 1. price (remove its substrings from the working text)
  const priceHit = extractPrice(text);
  let working = text;
  for (const r of priceHit.raw) {
    working = working.replace(r, ' ');
  }

  // 2. gm number (on the price-stripped text, so a price isn't read as OEM)
  const gmHit = extractGmNumber(working);
  for (const r of gmHit.raw) {
    working = working.replace(r, ' ');
  }

  // 3. brand + models from the local catalog
  const catalog = matchCatalog(working);
  for (const token of catalog.matchedTokens) {
    working = working.replace(wordRegex(token), ' ');
  }

  // 4. split what's left into title + description
  const { title, description } = splitTitleAndDescription(working);

  // 5. confidence
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
  };
}
