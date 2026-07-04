// src/ai/structured-parser.ts
//
// Primary parse path for seller captions. Two shapes are supported:
//
//   A) PLAIN / POSITIONAL (Format 1) — blank-line separated paragraphs in a
//      fixed order:
//        Paragraph 1: title
//        Paragraph 2: description
//        Paragraph 3: GM/OEM number
//        Paragraph 4: price
//
//   B) LABELED (Formats 2 & 3) — each field is introduced by a label such as
//      "Название", "Описание", "GM", "OEM", "Цена" (optionally ending in ":").
//      A label may sit on the same line as its value ("Название: Магнитола") OR
//      alone on its own paragraph with the value in the following paragraph.
//
// Only the title and description are free text; they are preserved EXACTLY as
// written by the seller once the label prefix is removed (trim + collapse
// duplicate internal spaces only — no token stripping, no rewriting). Vehicle
// make/model is detected FROM the title but never modifies it. The GM/OEM and
// price paragraphs are parsed into gm_number / price.
//
// If the caption does not clearly follow either structured shape, we return null
// so the caller can fall back to the existing rule-based + AI pipeline.

import type { ParsedPartMetadata } from './part-parser.types';
import { parsePrice } from './price-parser';
import { matchCatalog } from './vehicle-catalog';

/** The four structured fields a label can introduce. */
type FieldKey = 'title' | 'description' | 'gm' | 'price';

// Label aliases → canonical field. Matched case-insensitively, with an optional
// trailing ":". Keep these lowercase; the matcher lowercases the input.
const LABELS: ReadonlyArray<{ field: FieldKey; aliases: readonly string[] }> = [
  { field: 'title', aliases: ['название', 'наименование', 'товар', 'title', 'name'] },
  { field: 'description', aliases: ['описание', 'description', 'desc', 'инфо'] },
  { field: 'gm', aliases: ['gm', 'oem', 'gm/oem', 'oem/gm', 'номер', 'артикул', 'код'] },
  { field: 'price', aliases: ['цена', 'price', 'стоимость', 'narx'] },
];

/**
 * Split a caption into its logical fields — ONE PER NON-EMPTY LINE.
 *
 * The official seller format uses a single newline between fields
 * (title / description / GM / price). Blank lines are optional and ignored, so
 * these two inputs normalize to the identical field array:
 *
 *   "Title\nDesc\n96234567\n450000"        (single newlines)
 *   "Title\n\nDesc\n\n96234567\n\n450000"  (blank lines)
 *   → ["Title", "Desc", "96234567", "450000"]
 *
 * Each line is whitespace-normalized only (trim + collapse duplicate spaces);
 * empty / whitespace-only lines are dropped. CRLF and CR are normalized to LF
 * first. The function name is kept for compatibility; a "paragraph" is now a
 * single non-empty line.
 */
export function splitParagraphs(raw: string): string[] {
  return raw
    .replace(/\r\n?/g, '\n')
    .split('\n') // every newline is a field boundary
    .map((line) => normalizeLine(line))
    .filter((line) => line.length > 0); // ignore blank / whitespace-only lines
}

/** Whitespace-normalize a single line: collapse runs of spaces/tabs, then trim. */
function normalizeLine(line: string): string {
  return line.replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * If a paragraph starts with a known label, return the matched field and the
 * inline value that follows the label on the same line (empty string when the
 * label stands alone). Returns null when the paragraph is not a label.
 *
 * A label is only recognized at the very start of the paragraph, optionally
 * followed by ":" and/or the value. This prevents a normal title that merely
 * contains the word "цена" somewhere from being treated as a label.
 */
function matchLabel(paragraph: string): { field: FieldKey; inlineValue: string } | null {
  for (const { field, aliases } of LABELS) {
    for (const alias of aliases) {
      const re = new RegExp(`^${escapeRegExp(alias)}\\s*:?\\s*(.*)$`, 'is');
      const m = paragraph.match(re);
      if (m) return { field, inlineValue: m[1].trim() };
    }
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A value that is (mostly) an OEM/GM number: a digit run, optionally with a
 *  few surrounding letters/separators, ≥4 digits total. */
function parseGmValue(p: string): string | null {
  const digits = p.replace(/\D/g, '');
  if (digits.length < 4 || digits.length > 17) return null;
  // Reject values that are clearly prose (lots of letters vs digits).
  const letters = (p.match(/[a-zа-яё]/gi) || []).length;
  if (letters > 3) return null;
  return digits;
}

/**
 * A value that is a price: a number, optionally with thousands separators (".",
 * ",", or space) and/or a trailing currency word. Delegates to the shared
 * parsePrice so "130.000" → 130000 (dot as thousands) while "130.00" → 130
 * (dot as decimal). The value must be the WHOLE field (currency aside) — a
 * paragraph carrying other text is not a bare price and is rejected.
 */
function parsePriceValue(p: string): number | null {
  // Guard: the price field must be only a number (+ optional currency word),
  // matching the previous strict-anchor behavior so prose lines don't parse as
  // prices. parsePrice itself then applies the thousands/decimal rules.
  if (!/^\s*\d[\d.,\s]*\s*(uzs|сум|сўм|so'm|som|usd|\$|у\.е\.?)?\s*$/i.test(p)) {
    return null;
  }
  return parsePrice(p);
}

/** Assemble the final metadata from resolved field values, detecting the
 *  vehicle make/model from the (already label-free) title without altering it. */
function build(fields: {
  title: string | null;
  description: string | null;
  gm: string | null;
  price: number | null;
}): ParsedPartMetadata | null {
  const title = fields.title?.trim() || '';
  if (title.length < 3) return null;

  const catalog = matchCatalog(title);
  return {
    title,
    description: fields.description?.trim() || null,
    brand: catalog.brand,
    models: catalog.models,
    gm_number: fields.gm,
    price: fields.price,
  };
}

/**
 * Parse a LABELED caption (Formats 2 & 3). Walks the paragraphs; a label either
 * carries its value inline or claims the next paragraph. Labels are stripped
 * from the stored values. Returns null if no label is present (so the caller
 * tries the positional parser) or if a labeled value fails to validate.
 */
function parseLabeled(paragraphs: string[]): ParsedPartMetadata | null {
  const values: Partial<Record<FieldKey, string>> = {};
  let sawLabel = false;

  for (let i = 0; i < paragraphs.length; i++) {
    const label = matchLabel(paragraphs[i]);
    if (!label) {
      // A non-label paragraph with no preceding open label is unexpected in the
      // labeled format — bail so we don't silently drop seller text.
      return null;
    }
    sawLabel = true;

    let value = label.inlineValue;
    if (!value) {
      // Standalone label (Format 3): the value is the next paragraph, which must
      // exist and must not itself be a label.
      const next = paragraphs[i + 1];
      if (next === undefined || matchLabel(next)) return null;
      value = next;
      i++; // consume the value paragraph
    }

    // First occurrence wins; ignore duplicate labels rather than overwriting.
    if (values[label.field] === undefined) values[label.field] = value;
  }

  if (!sawLabel) return null;
  if (values.title === undefined) return null; // title is required

  let gm: string | null = null;
  if (values.gm !== undefined) {
    gm = parseGmValue(values.gm);
    if (gm === null) return null; // labeled GM present but not a valid number
  }

  let price: number | null = null;
  if (values.price !== undefined) {
    price = parsePriceValue(values.price);
    if (price === null) return null; // labeled price present but not a valid price
  }

  return build({
    title: values.title,
    description: values.description ?? null,
    gm,
    price,
  });
}

/**
 * Parse the OFFICIAL positional format (one field per non-empty line):
 *
 *   Line 1: title
 *   Line 2: description
 *   Line 3: GM/OEM number
 *   Line 4: price
 *   Line 5+: additional description, folded in.
 *
 * Fields are assigned BY POSITION (title=1, description=2, GM=3, price=4). A GM
 * or price line that does not validate is treated as description text instead of
 * rejecting the caption, and any line 5+ is appended to the description — so the
 * official single-line-per-field layout is honored while extra/blank-separated
 * lines never leak into the title. Requires ≥2 lines (a single line → fallback).
 */
function parsePositional(lines: string[]): ParsedPartMetadata | null {
  if (lines.length < 2) return null;

  const title = lines[0];
  const descriptionLines: string[] = [];

  // Line 2 → description.
  if (lines[1] !== undefined) descriptionLines.push(lines[1]);

  // Line 3 → GM if it validates, else description.
  let gm: string | null = null;
  if (lines[2] !== undefined) {
    gm = parseGmValue(lines[2]);
    if (gm === null) descriptionLines.push(lines[2]);
  }

  // Line 4 → price if it validates, else description.
  let price: number | null = null;
  if (lines[3] !== undefined) {
    price = parsePriceValue(lines[3]);
    if (price === null) descriptionLines.push(lines[3]);
  }

  // Lines 5+ → description.
  for (let i = 4; i < lines.length; i++) descriptionLines.push(lines[i]);

  return build({
    title,
    description: descriptionLines.length ? descriptionLines.join(' ') : null,
    gm,
    price,
  });
}

/**
 * Attempt to parse a caption as a structured format (labeled or positional).
 * Returns null when the caption doesn't fit either, so the caller falls back to
 * the AI/rule-based parser.
 *
 * A single-paragraph caption with no label is NOT considered structured.
 */
export function parseStructuredCaption(raw: string): ParsedPartMetadata | null {
  const paragraphs = splitParagraphs(raw);
  if (paragraphs.length === 0) return null;

  // A caption is treated as LABELED when its first paragraph is a label — every
  // labeled example leads with "Название". In that case we commit to the labeled
  // parser: if it fails validation we return null (→ AI fallback) rather than
  // falling through to positional, which would otherwise store the raw label
  // text (e.g. "Название: …") as the title.
  //
  // A caption whose first paragraph is NOT a label uses the positional parser
  // (Format 1), so a plain caption whose later paragraph merely starts with a
  // label word (e.g. a description "Цена договорная") is still read positionally.
  if (matchLabel(paragraphs[0]) !== null) {
    return parseLabeled(paragraphs);
  }
  return parsePositional(paragraphs);
}
