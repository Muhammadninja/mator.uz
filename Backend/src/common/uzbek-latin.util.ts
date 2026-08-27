/**
 * The rule for what counts as a name written in UZBEK LATIN — the script the
 * `uz` locale ships in, and the only script `nameUz` may be stored in.
 *
 * Split from its class-validator decorator (see
 * ./is-uzbek-latin.validator) so the same predicate can back a DTO, a seed
 * check, and a data audit — the pattern `asset-url.util` /
 * `is-allowed-asset-url.validator` already established.
 *
 * ── What the alphabet actually is ─────────────────────────────────────────
 * Uzbek Latin is the 26 basic Latin letters plus two digraphs that are single
 * LETTERS of the alphabet — Oʻ and Gʻ — and the tutuq belgisi (ʼ), a letter in
 * its own right marking a glottal stop ("ta'mir"). Unicode's preferred forms
 * are U+02BB MODIFIER LETTER TURNED COMMA for the Oʻ/Gʻ stroke and U+02BC
 * MODIFIER LETTER APOSTROPHE for the tutuq belgisi, but essentially nobody
 * types those: real data (this repo's own 237 seeded translations, every one of
 * them) uses the plain ASCII apostrophe, and phones produce the curly U+2018 /
 * U+2019. All of them are accepted as the same letter — rejecting a name
 * because the keyboard produced ' instead of ʻ would fail valid Uzbek and
 * teach admins that the field is broken.
 *
 * Ch and Sh are the remaining digraphs, but they are spelled with letters
 * already in the set, so they need no rule of their own.
 *
 * ── What is deliberately allowed besides letters ──────────────────────────
 * Category names are not prose: "4WD ehtiyot qismi", "Euro-5", "ABS sensor",
 * "12V" are all legitimate. So digits, spaces, hyphens, slashes, dots, commas,
 * parentheses, & and + pass. The point of this check is NOT to police
 * punctuation — it is to catch a name typed in the WRONG SCRIPT, which is the
 * mistake that actually happens (Russian pasted into the Uzbek field).
 *
 * ── What is rejected ──────────────────────────────────────────────────────
 * Any letter outside Latin: Cyrillic above all ("Тормоз колодкalari"), but
 * equally Arabic, Greek or CJK. A mixed string is rejected precisely because
 * ONE Cyrillic letter is the signature of a half-translated name.
 */

/**
 * The apostrophe-like characters accepted for Oʻ/Gʻ and the tutuq belgisi.
 * Order matters only for readability; all are folded to U+02BB by
 * {@link normalizeUzbekApostrophes}.
 */
const APOSTROPHE_FORMS = [
  "'", // U+0027 APOSTROPHE — what every keyboard and this repo's seeds produce
  '‘', // ‘ LEFT SINGLE QUOTATION MARK — iOS/Android smart quotes
  '’', // ’ RIGHT SINGLE QUOTATION MARK — Word/iOS autocorrect
  'ʻ', // ʻ MODIFIER LETTER TURNED COMMA — Unicode's Oʻ/Gʻ stroke
  'ʼ', // ʼ MODIFIER LETTER APOSTROPHE — Unicode's tutuq belgisi
  '`', // ` GRAVE ACCENT — a common mistype for the above
  '´', // ´ ACUTE ACCENT — likewise
] as const;

const APOSTROPHE_CLASS = `[${APOSTROPHE_FORMS.join('')}]`;

/** The canonical apostrophe every accepted form folds to. */
export const UZBEK_APOSTROPHE = 'ʻ';

/**
 * Punctuation, digits and separators a category name may legitimately carry.
 * Widened only by real naming needs ("Euro-5", "Moy (sintetika)", "Tormoz/ABS",
 * "Yog' & filtr", "1.6 L", "12V, 24V", "Diskli+barabanli").
 */
const ALLOWED_PUNCTUATION = String.raw` 0-9\-–—/\\.,:;()«»"&+%°×x*_\[\]`;

/**
 * A name is Uzbek Latin when every character is either a basic Latin letter, an
 * accepted apostrophe form, or allowed punctuation. Built from a NEGATED class
 * (find the first offending character) rather than a positive full-string
 * match, so the two read as one rule and a future addition cannot drift.
 */
// None of the apostrophe forms is special inside a character class, so they are
// interpolated verbatim; ALLOWED_PUNCTUATION carries its own escaping.
const DISALLOWED_CHAR = new RegExp(
  `[^A-Za-z${ALLOWED_PUNCTUATION}${APOSTROPHE_FORMS.join('')}]`,
  'u',
);

/** True when the string contains at least one Latin letter. */
const HAS_LATIN_LETTER = /[A-Za-z]/;

/**
 * Fold every accepted apostrophe form to {@link UZBEK_APOSTROPHE}, so two
 * visually identical spellings of "Yog'" compare equal. Exported for callers
 * that want to STORE a canonical form; the validator itself does not normalize
 * (it accepts all forms), so no admin's input is silently rewritten.
 */
export function normalizeUzbekApostrophes(value: string): string {
  return value.replace(new RegExp(APOSTROPHE_CLASS, 'gu'), UZBEK_APOSTROPHE);
}

/**
 * Whether `value` is a non-blank name written in Uzbek Latin.
 *
 * NFC-normalizes first so a decomposed sequence (a base letter plus a combining
 * mark, which some keyboards emit) is judged by the character it renders as
 * rather than by its combining mark, which would otherwise trip the
 * disallowed-character check on a perfectly valid name.
 *
 * Requires at least one Latin letter, so "123" or "---" is not accepted as a
 * name; blank/whitespace-only is likewise false. Non-strings are false — this
 * is a content rule, and `@IsString()` reports a wrong TYPE separately.
 */
export function isUzbekLatin(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.normalize('NFC').trim();
  if (normalized === '') return false;
  if (!HAS_LATIN_LETTER.test(normalized)) return false;
  return !DISALLOWED_CHAR.test(normalized);
}
