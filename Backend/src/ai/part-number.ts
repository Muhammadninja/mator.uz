// src/ai/part-number.ts
//
// Classifies HOW a seller labeled a part number — GM, OEM, or unlabeled
// (UNKNOWN). This is the ONLY thing that decides the type: we never guess from
// the number's shape/length and never ask the LLM. An unlabeled number stays
// UNKNOWN so it remains searchable as BOTH a GM and an OEM number.
//
// The distinction must be preserved end-to-end: a GM-labeled number populates
// only the GM field, an OEM-labeled number only the OEM field, and neither is
// ever copied into the other automatically.

import type { PartNumberType } from './part-parser.types';

// ─────────────────────────────────────────────────────────────────────────────
// THE SINGLE OEM/GM PART-NUMBER LABEL RULE for the whole codebase.
//
// A number's type is decided ONLY by an explicit label ATTACHED TO A NUMBER —
// never by the digits, never by the LLM, and never by product-authenticity words
// ("оригинал"/"original"/"genuine"/"factory"/"заводской") or manufacturer/brand
// markers ("ACDelco"/"General Motors"). Those describe the product, not whether a
// GM/OEM part number was provided. A bare concept phrase like "OEM quality" or
// "GM compatible" therefore does NOT label the number. `classifyPart` in
// part-classifier.ts consumes the PartNumberType this produces; it does not
// re-implement any of this.
// ─────────────────────────────────────────────────────────────────────────────

// "GM"/"ГМ" as a part-number label directly attached to a number, e.g.
// "GM 96440756", "GM: 96440756", "GM № 96440756", "GM No. 96440756". A bare
// "GM"/"ГМ" NOT next to a number (brand mention, "GM compatible") does NOT count.
// (JS \b is latin-only, so the leading boundary is explicit.)
const GM_LABEL_WITH_NUMBER =
  /(^|[^a-zа-яё0-9])(gm|гм)\s*(?:part\s*)?(?:number|no\.?|№|#|:)?\s*[:#-]?\s*\d{3,}/i;

// "OEM"/"ОЕМ"/"ОЄМ"/"ОЭМ"/"ОѐМ" as a part-number label directly attached to a
// number, e.g. "OEM: 93745764", "OEM № 93745764", "OEM No. 93745764",
// "OEM Number: 93745764", "OEM Part Number 93745764". A bare "OEM quality"/
// "OEM part"/"OEM compatible" (no number) does NOT count.
const OEM_LABEL_WITH_NUMBER =
  /(^|[^a-zа-яё0-9])(oem|о[еэєѐ]м)\s*(?:part\s*)?(?:number|no\.?|№|#|:)?\s*[:#-]?\s*\d{3,}/i;

// A COMBINED "GM/OEM" (or "OEM/GM", either script, any join char) label attached
// to a number — the seller marked it as both, so we cannot pick a side → the type
// stays UNKNOWN (searchable as both). Checked before the single-label patterns so
// "GM/OEM 96535062" isn't mis-read as OEM just because OEM sits nearer the digits.
const COMBINED_LABEL_WITH_NUMBER =
  /(^|[^a-zа-яё0-9])((gm|гм)\s*[\/&+]\s*(oem|о[еэєѐ]м)|(oem|о[еэєѐ]м)\s*[\/&+]\s*(gm|гм))\s*(?:part\s*)?(?:number|no\.?|№|#|:)?\s*[:#-]?\s*\d{3,}/i;

/**
 * Decide the part-number type from the seller's text, given the raw number that
 * was extracted from it. Returns:
 *   'GM'      when the text carries a GM number-label but NOT an OEM number-label,
 *   'OEM'     when the text carries an OEM number-label but NOT a GM number-label,
 *   'UNKNOWN' when there is no explicit number-label, or BOTH labels appear
 *             (ambiguous — we do not pick a side; UNKNOWN keeps it searchable by
 *             both). Marketing/authenticity words never count as a label.
 *
 * When no number was extracted, the type is 'UNKNOWN' (nothing to label). We
 * intentionally do NOT look at the digits themselves — only the label decides.
 */
export function classifyPartNumberType(
  text: string | null | undefined,
  rawNumber: string | null | undefined,
): PartNumberType {
  if (!rawNumber) return 'UNKNOWN';
  // Scan the caption AND the number token so an inline "OEM 93745764" that lives
  // in the extracted number is still labeled.
  const haystack = `${text ?? ''} ${rawNumber}`;
  // A combined "GM/OEM" label is ambiguous — neither side wins.
  if (COMBINED_LABEL_WITH_NUMBER.test(haystack)) return 'UNKNOWN';
  const hasGm = GM_LABEL_WITH_NUMBER.test(haystack);
  const hasOem = OEM_LABEL_WITH_NUMBER.test(haystack);
  if (hasGm && !hasOem) return 'GM';
  if (hasOem && !hasGm) return 'OEM';
  return 'UNKNOWN';
}

/**
 * Map a labeled number into the separate gm/oem fields WITHOUT ever cross-copying
 * one into the other:
 *   GM      → { gm: n,  oem: null }
 *   OEM     → { gm: null, oem: n }
 *   UNKNOWN → { gm: n,  oem: null }  (kept in gm for the legacy unique key; the
 *             UNKNOWN type is what makes it searchable as both — see the catalog
 *             projection, which mirrors an UNKNOWN number into both arrays).
 *
 * A null number yields both null.
 */
export function splitPartNumber(
  rawNumber: string | null | undefined,
  type: PartNumberType,
): { gmNumber: string | null; oemNumber: string | null } {
  const n = rawNumber ?? null;
  if (n === null) return { gmNumber: null, oemNumber: null };
  if (type === 'OEM') return { gmNumber: null, oemNumber: n };
  // GM and UNKNOWN both keep the value in gmNumber (the idempotency key column);
  // UNKNOWN's dual searchability is handled at projection time, not by copying.
  return { gmNumber: n, oemNumber: null };
}
