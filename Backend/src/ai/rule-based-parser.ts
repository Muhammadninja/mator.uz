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
import { deriveVehicleCompatibility, matchCatalog } from './vehicle-catalog';

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

// ── Currency indicators ───────────────────────────────────────────────────────
// All the ways sellers write the local currency, including OCR/typing artifacts.
// The apostrophe class [ʼʻ'`’] covers the modifier-letter apostrophe (U+02BB),
// the straight quote (U+0027), the grave and the curly quote — sellers use all
// of them for "so'm". Latin "o"/Cyrillic "о" and Latin "c"/Cyrillic "с" are both
// accepted because OCR/keyboards mix the scripts (e.g. "сoʻм" = Cyrillic-с +
// Latin-o + ʻ + Cyrillic-м). Longest alternatives come first so the regex
// engine prefers e.g. "soʻm" over a shorter "som".
//   Required set: sum, som, сум, сом, so'm, сўм, сoʻм, soʻm, UZS  (+ usd, $, у.е.)
// Kept as ONE source of truth so the price extractors and the AI prompt agree.
const APOS = "[ʼʻ'`’]";
export const CURRENCY_WORD = [
  'uzs',
  'usd',
  `s[oо]${APOS}m`, // so'm / soʻm  (Latin s + o/о + apostrophe + m)
  `[сc][oо]${APOS}м`, // сoʻм        (Cyr/Lat с + o/о + apostrophe + Cyr м)
  'с[ўу]м', // сўм / сум
  'с[оo]м', // сом / сoм
  's[uу]m', // sum
  's[oо]m', // som
  '\\$',
  'у\\.?\\s?е\\.?',
].join('|');
const CURRENCY_RE_SRC = `(?:${CURRENCY_WORD})`;

// ── Field extractors ──────────────────────────────────────────────────────────

interface PriceHit {
  value: number | null;
  /** substring(s) to remove from the text before building the title. */
  raw: string[];
}

/**
 * Extract a price VALUE from free text (a full seller caption), returning the
 * parsed number or null. This is the SINGLE robust text→price entry point:
 * it finds the number adjacent to a currency word (or a safe bare number),
 * ignoring GM codes / phones / years / mileage, and runs it through the shared
 * parsePrice so "130.000 сум" → 130000. Exported so callers outside the parser
 * (e.g. the Telegram fallback) never reimplement price extraction.
 */
export function extractPriceFromText(text: string): number | null {
  return extractPrice(text).value;
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
  const currencyRe = new RegExp(
    `(\\d[\\d.,]*(?:\\s\\d{3})*(?:[.,]\\d{1,2})?)\\s*${CURRENCY_RE_SRC}`,
    'gi',
  );
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
    // Skip numbers that are clearly NOT a price: phone numbers, years, mileage,
    // dimensions, quantities, article/OEM codes (rule #6). Without a currency
    // marker we must be conservative or we'd treat a year/phone as the price.
    if (isUnrelatedNumber(match[0], match.index ?? 0, text)) continue;
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

/**
 * True when a bare number (no currency marker next to it) is almost certainly
 * NOT a price and should be ignored per rule #6: phone numbers, years, mileage,
 * dimensions, quantities, article numbers, etc. Used ONLY for the currency-less
 * fallback — a number sitting right before a currency word is always trusted.
 *
 * `raw` is the matched number token, `index` its offset in `text`, so we can
 * inspect the surrounding characters (e.g. a "km"/"год" suffix, a leading "+").
 */
function isUnrelatedNumber(raw: string, index: number, text: string): boolean {
  const digits = raw.replace(/\D/g, '');
  const after = text.slice(index + raw.length, index + raw.length + 6).toLowerCase();
  const before = text.slice(Math.max(0, index - 2), index);

  // Phone number: a "+" immediately before, or a 9+ digit run.
  if (before.endsWith('+')) return true;
  if (digits.length >= 9) return true;

  // A 4-digit number that reads as a YEAR (1900–2099) is not a price.
  if (/^(19|20)\d{2}$/.test(digits) && digits.length === 4) return true;

  // Unit-suffixed numbers: mileage (km/км), dimensions (mm/см/mm/x), volume,
  // weight, quantity (шт/pcs) — the unit right after the number gives it away.
  if (/^\s*(км|km|мм|mm|см|cm|л\b|kg|кг|г\b|мл|ml|шт|pcs|год|года|лет|year|x|х|×|\*)/.test(after)) {
    return true;
  }

  return false;
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

/**
 * GM detector for the description-recovery path. The task specifies a GM part
 * number as EXACTLY 11 digits; in practice local GM/OEM codes are 8–11 digits,
 * so we accept an 8–11 digit run and PREFER a full 11-digit match when both are
 * present. Anchored on non-digit boundaries, so a 12+ digit phone number never
 * yields a valid substring (its whole run is rejected). This deliberately
 * rejects the 5–7 digit codes the flexible title detector allows, keeping short
 * article numbers out of the description-recovery path.
 */
function extractGmNumber11(text: string): GmHit {
  // Prefer an exact 11-digit code first (the canonical GM length per the spec).
  const exact = text.match(/(?<!\d)(\d{11})(?!\d)/);
  if (exact) return { value: exact[1], raw: [exact[1]] };
  // Otherwise accept an 8–10 digit run (real GM codes are commonly 8 digits).
  const m = text.match(/(?<!\d)(\d{8,10})(?!\d)/);
  if (!m) return { value: null, raw: [] };
  return { value: m[1], raw: [m[1]] };
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

  // Vehicle compatibility from the price/GM-scrubbed working copy: universal
  // claim wins, otherwise every catalog match paired with its own brand.
  const compat = deriveVehicleCompatibility([working]);

  // Condition words → description (extracted, not removed from the title).
  const description = extractConditionWords(text);

  // Title = the seller's line, verbatim except whitespace normalization.
  const title = normalizeTitle(text);

  const hasBrandOrModel =
    Boolean(compat.brand) || compat.models.length > 0 || compat.isUniversal;
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
    brand: compat.brand,
    models: compat.models,
    vehicles: compat.vehicles,
    isUniversal: compat.isUniversal,
    gm_number: gmHit.value,
    price: priceHit.value,
    confidence,
    // Title is the seller's verbatim text — the sanitizer must not rewrite it.
    preserveTitle: true,
  };
}

/** The four structured fields we extract from a text chunk (title or desc). */
interface ExtractedFields {
  brand: string | null;
  models: string[];
  gm_number: string | null;
  price: number | null;
  /** GM/price raw tokens, so the caller can scrub them from description text. */
  gmRaw: string[];
  priceRaw: string[];
  /** The chunk with price/GM tokens scrubbed — safe input for the catalog. */
  working: string;
}

/**
 * Extract brand / model / GM / price from ONE text chunk. Pure detection: does
 * not modify or return the chunk. `strictGm11` selects the GM detector — the
 * DESCRIPTION path requires EXACTLY 11 digits (rule #4), while the title/general
 * path keeps the historical flexible 5–11 digit detector so existing 8-digit
 * codes still resolve.
 */
function extractFields(chunk: string, strictGm11: boolean): ExtractedFields {
  const priceHit = extractPrice(chunk);
  let working = chunk;
  for (const r of priceHit.raw) working = working.replace(r, ' ');

  const gmHit = strictGm11 ? extractGmNumber11(working) : extractGmNumber(working);
  for (const r of gmHit.raw) working = working.replace(r, ' ');

  const catalog = matchCatalog(working);
  return {
    brand: catalog.brand,
    models: catalog.models,
    gm_number: gmHit.value,
    price: priceHit.value,
    gmRaw: gmHit.raw,
    priceRaw: priceHit.raw,
    working,
  };
}

/**
 * Multi-line caption: line 1 is the TITLE, the remaining lines are the
 * DESCRIPTION. GM/price: the title is analyzed first and the description only
 * RECOVERS what the title did not supply (title values always win, rule #3;
 * description GM must be EXACTLY 11 digits, rule #4).
 *
 * Vehicle compatibility is different: it is the UNION of the TITLE (line 1)
 * and the DESCRIPTION (line 2) — the description is no longer ignored when the
 * title already names a model. Only lines 1 & 2 are ever fed to the catalog
 * matcher — never lines 3+ (GM/price) — and both chunks are price/GM-scrubbed
 * first. A universal-fitment claim in either line wins over model extraction.
 *
 * The title text is still preserved verbatim (whitespace-normalized) — make /
 * model / OEM / price are extracted into fields but never stripped from it, and
 * no description text can leak into the title.
 */
function parseMultiParagraph(paragraphs: string[]): RuleBasedResult {
  const titleParagraph = paragraphs[0];
  const restText = normalizeText(paragraphs.slice(1).join(' '));

  // 1. TITLE first (flexible GM detector, historical behavior).
  const fromTitle = extractFields(normalizeText(titleParagraph), false);

  // 2. DESCRIPTION fallback — only run when the title left a gap (rule #2).
  const titleHasAllFields =
    Boolean(fromTitle.brand) &&
    fromTitle.models.length > 0 &&
    Boolean(fromTitle.gm_number) &&
    fromTitle.price !== null;

  let fromDesc: ExtractedFields | null = null;
  if (!titleHasAllFields && restText) {
    // Strict 11-digit GM for the description recovery path (rule #4).
    fromDesc = extractFields(restText, true);
  }

  // 3. Vehicle compatibility = UNION of line 1 and line 2 (price/GM-scrubbed).
  // Lines 3+ are never a make/model source — a number line can't contribute.
  const line2Fields =
    paragraphs[1] !== undefined
      ? extractFields(normalizeText(paragraphs[1]), true)
      : null;
  const compat = deriveVehicleCompatibility([fromTitle.working, line2Fields?.working]);
  const { brand, models, vehicles, isUniversal } = compat;

  // 4. MERGE GM/price — title wins; description fills only the gaps.
  const gm_number = fromTitle.gm_number ?? fromDesc?.gm_number ?? null;
  const price = fromTitle.price ?? fromDesc?.price ?? null;

  // Description text = remaining paragraphs with the DESCRIPTION's own GM/price
  // tokens scrubbed (so a recovered number doesn't also sit in the prose).
  let restWorking = restText;
  if (fromDesc) {
    for (const r of [...fromDesc.priceRaw, ...fromDesc.gmRaw]) {
      restWorking = restWorking.replace(r, ' ');
    }
  }
  const description = cleanDescription(restWorking);

  // Title = first paragraph, verbatim except whitespace normalization.
  const title = normalizeTitle(titleParagraph);

  const hasBrandOrModel = Boolean(brand) || models.length > 0 || isUniversal;
  const goodTitle = looksLikeGoodTitle(title);
  const confidence = computeConfidence({
    hasGm: Boolean(gm_number),
    hasPrice: price !== null,
    hasBrandOrModel,
    hasGoodTitle: goodTitle,
  });

  return {
    title,
    description,
    brand,
    models,
    vehicles,
    isUniversal,
    gm_number,
    price,
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
