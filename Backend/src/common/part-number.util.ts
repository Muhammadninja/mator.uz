import { normalizeOem } from './normalize-oem.util';

/**
 * Part numbers as SEARCH INPUT and as IDENTIFIERS (Wave 5).
 *
 * `normalizeOem` is the storage canonical form and is left exactly as it is:
 * every stored `gm_numbers` / `oem_numbers` entry and the GIN lookups depend on
 * it. It uppercases and drops EVERYTHING that is not A–Z / 0–9 — separators,
 * but also Cyrillic and other letters. Applied blindly to a buyer's query that
 * second part manufactures numbers nobody typed: "ВАЗ 2106" → "2106",
 * "Нексия 3" → "3", a Cyrillic look-alike "А123" → "123". This module decides
 * WHEN a text is a part number at all, before the canonical form is used.
 *
 * Rules:
 * - The original text is never rewritten; the canonical form is only a key.
 * - Identifiers stay strings: leading zeros survive ("09593992" ≠ "9593992").
 * - Case is folded (stored canonical forms are uppercase).
 * - Only separators are dropped: space . - / _ between Latin letters/digits.
 *   A text with any other character is NOT a part number, so it gets no
 *   canonical-form lookup (a literal, exact lookup is still safe — see
 *   literalNumberForms).
 * - Two numbers with one canonical form are a COLLISION to report, not proof
 *   that the parts are the same or interchangeable (compareIdentifiers).
 */

/** Longest canonical number accepted, as the DV importer's field limit. */
export const MAX_PART_NUMBER_LENGTH = 50;
/** Longest text tried as an exact stored spelling. */
const MAX_LITERAL_LENGTH = 120;

const SEPARATOR = /[ .\-/_]/;
const EDGE_SEPARATORS = /^[ .\-/_]+|[ .\-/_]+$/g;
/** Latin letters and digits, separators only BETWEEN them. */
const NUMBER_SHAPE = /^[A-Za-z0-9]+(?:[ .\-/_]+[A-Za-z0-9]+)*$/;

export type PartNumberRejection =
  'empty' | 'unsupported_characters' | 'too_long';

export interface PartNumberQuery {
  /** The text as given, trimmed. Never shown rewritten. */
  original: string;
  /** normalizeOem(original): the stored lookup key. */
  canonical: string;
}

export type ParsedPartNumber =
  | { ok: true; value: PartNumberQuery }
  | { ok: false; reason: PartNumberRejection };

/**
 * Whether `text` is a part number, and its canonical lookup key if so.
 * Separators at the edges ("96.943.770.") are ignored; nothing else is.
 */
export function parsePartNumber(
  text: string | null | undefined,
): ParsedPartNumber {
  const original = (text ?? '').trim();
  const core = original.replace(EDGE_SEPARATORS, '');
  if (!core) return { ok: false, reason: 'empty' };
  if (!NUMBER_SHAPE.test(core)) {
    return { ok: false, reason: 'unsupported_characters' };
  }
  const canonical = normalizeOem(core);
  if (canonical.length > MAX_PART_NUMBER_LENGTH) {
    return { ok: false, reason: 'too_long' };
  }
  return { ok: true, value: { original, canonical } };
}

/** The canonical lookup key of `text`, or null when it is not a part number. */
export function partNumberKey(text: string | null | undefined): string | null {
  const parsed = parsePartNumber(text);
  return parsed.ok ? parsed.value.canonical : null;
}

/** Shortest part number taken from a text that also holds words. */
export const MIN_NUMBER_BESIDE_WORDS = 5;

const hasDigit = (s: string): boolean => /[0-9]/.test(s);

/**
 * The canonical part numbers a search text names. A number has a digit, so a
 * word ("pads", "фильтр") is never one. Then: the whole text when it is a part
 * number ("SP 1362", "96.943.770"); otherwise each whitespace-separated piece
 * that is one and is at least MIN_NUMBER_BESIDE_WORDS long ("масляный фильтр
 * 96879797" → 96879797). A short number beside words is more likely a model
 * ("ВАЗ 2106", "Нексия 3") and is not looked up, and a piece with a non-Latin
 * letter ("А123") is never a number.
 */
export function partNumbersInText(text: string | null | undefined): string[] {
  const whole = partNumberKey(text);
  if (whole) return hasDigit(whole) ? [whole] : [];
  const keys = (text ?? '')
    .split(/\s+/)
    .map((piece) => partNumberKey(piece))
    .filter(
      (k): k is string =>
        !!k && k.length >= MIN_NUMBER_BESIDE_WORDS && hasDigit(k),
    );
  return [...new Set(keys)];
}

/**
 * The spellings to try as an EXACT stored entry: the text as typed and its
 * uppercase. Exact equality with a stored spelling cannot invent a number, so
 * this applies to a text that is not number-shaped too (a legacy Telegram
 * number may hold Cyrillic, e.g. "ЗМЗ-406") — as long as it has a digit, so a
 * plain word stays a title search.
 */
export function literalNumberForms(text: string | null | undefined): string[] {
  const original = (text ?? '').trim();
  if (!original || original.length > MAX_LITERAL_LENGTH) return [];
  if (!hasDigit(original)) return [];
  return [...new Set([original, original.toUpperCase()])];
}

/** Whether a stored number has characters normalizeOem would silently drop. */
export function hasDroppedCharacters(stored: string): boolean {
  const core = stored.trim().replace(EDGE_SEPARATORS, '');
  return core.length > 0 && !NUMBER_SHAPE.test(core);
}

/** The digit-only number with its leading zeros, e.g. "09593992" → true. */
export function hasLeadingZero(canonical: string): boolean {
  return /^0[0-9]/.test(canonical);
}

/** Whether the text has a separator between two characters, e.g. "SP-1362". */
export function hasSeparators(text: string): boolean {
  return SEPARATOR.test(text.trim().replace(EDGE_SEPARATORS, ''));
}

// ── identity ───────────────────────────────────────────────────────────────

/**
 * How a number is labelled, per number (the projection rule): in gm_numbers
 * only → GM, in oem_numbers only → OEM, in both → UNLABELLED.
 */
export type PartNumberScheme = 'GM' | 'OEM' | 'UNLABELLED';

/** A number together with WHOSE number it is. */
export interface PartIdentifier {
  scheme: PartNumberScheme;
  /** The part's manufacturer (part brand), null when not recorded. */
  manufacturer: string | null;
  /** As stored / as written. */
  original: string;
}

export type IdentifierRelation =
  /** Same spelling, scheme and manufacturer. */
  | 'identical'
  /** Same number, scheme and manufacturer, written differently ("SP-1362"). */
  | 'format_variant'
  /** One canonical form, but another or an unknown owner: NOT equivalence. */
  | 'collision'
  | 'different';

const owner = (m: string | null): string | null => {
  const t = m?.trim().toLowerCase();
  return t ? t : null;
};

/**
 * How two identifiers relate. Never says "interchangeable": that needs evidence
 * (Wave 4 cross-reference), not a string comparison. An unknown manufacturer
 * on either side is a collision, because the owner cannot be shown to match.
 */
export function compareIdentifiers(
  a: PartIdentifier,
  b: PartIdentifier,
): IdentifierRelation {
  const ca = normalizeOem(a.original);
  const cb = normalizeOem(b.original);
  if (!ca || ca !== cb) return 'different';
  const ma = owner(a.manufacturer);
  const mb = owner(b.manufacturer);
  if (a.scheme !== b.scheme || !ma || !mb || ma !== mb) return 'collision';
  return a.original.trim() === b.original.trim()
    ? 'identical'
    : 'format_variant';
}

/**
 * A key that keeps the owner: two parts share it only when scheme, manufacturer
 * AND canonical number all agree. Grouping by canonical alone merges owners.
 */
export function identifierKey(id: PartIdentifier): string {
  return [
    id.scheme,
    owner(id.manufacturer) ?? '?',
    normalizeOem(id.original),
  ].join('|');
}
