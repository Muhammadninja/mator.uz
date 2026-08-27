// Tests for the Uzbek-Latin alphabet rule — the content check behind `nameUz`.
// Kept at the util level (rather than only through the DTO) because seeds and
// data audits call the same predicate, so its contract is asserted once here
// and the DTO spec is left to prove the WIRING (required vs optional).

import {
  isUzbekLatin,
  normalizeUzbekApostrophes,
  UZBEK_APOSTROPHE,
} from './uzbek-latin.util';

describe('isUzbekLatin — accepts real Uzbek Latin', () => {
  it.each([
    ['a plain two-word name', 'Tormoz kolodkalari'],
    ['a system name', 'Tormoz tizimi'],
    ['a longer subcategory', 'Oldingi tormoz kolodkalari'],
    ['a two-word product name', 'Motor moyi'],
    ['an all-caps abbreviation', 'ABS'],
    ['an abbreviation inside a phrase', 'ABS sensor'],
    ['a digit-led technical name', '4WD ehtiyot qismi'],
  ])('accepts %s', (_label, value) => {
    expect(isUzbekLatin(value)).toBe(true);
  });

  // The Oʻ/Gʻ letters and the tutuq belgisi, in every form a real keyboard
  // produces. All are the SAME letter and must be accepted alike — this is the
  // case a naive /^[A-Za-z ]+$/ gets wrong.
  it.each([
    ['ASCII apostrophe (what the seeds and most keyboards emit)', "O'zbekiston"],
    ['U+02BB turned comma (Unicode’s preferred Oʻ)', 'Oʻzbekiston'],
    ['U+02BB in Gʻ', 'Gʻildirak'],
    ['a curly right quote from phone autocorrect', 'Yog’ filtri'],
    ['a curly left quote', 'Yog‘ filtri'],
    ['U+02BC tutuq belgisi', 'Taʼmirlash'],
    ['ASCII apostrophe mid-word', "Supportlar va ta'mirlash to'plamlari"],
    ['a backtick mistype', "Yog` filtri"],
  ])('accepts %s', (_label, value) => {
    expect(isUzbekLatin(value)).toBe(true);
  });

  // Category names carry model codes and specs; these must not be collateral
  // damage of a script check.
  it.each([
    ['a hyphenated standard', 'Euro-5'],
    ['a voltage', '12V'],
    ['a decimal engine size', 'Mator 1.6'],
    ['a bare abbreviation', 'OEM'],
    ['a slash pair', 'Tormoz/ABS'],
    ['parentheses', 'Moy (sintetika)'],
    ['a comma list', 'Moy, filtr'],
    ['an ampersand', 'Osma & rul'],
    ['a plus', 'Diskli+barabanli'],
  ])('accepts %s', (_label, value) => {
    expect(isUzbekLatin(value)).toBe(true);
  });
});

describe('isUzbekLatin — rejects the wrong script', () => {
  it.each([
    ['a fully Cyrillic name', 'Тормоз колодкалари'],
    ['a single Cyrillic word', 'Тормоз'],
    ['lowercase Cyrillic', 'Тест'],
    ['a Cyrillic common noun', 'колодки'],
  ])('rejects %s', (_label, value) => {
    expect(isUzbekLatin(value)).toBe(false);
  });

  // The signature of a half-finished translation: ONE Cyrillic letter is enough
  // to reject, which is the whole point — a mixed name renders as broken Uzbek.
  it.each([
    ['a Cyrillic word in a Latin phrase', 'Tormoz колодкалari'],
    ['a Cyrillic noun after a Latin one', 'Motor масло'],
    ['Cyrillic spliced into a Latin word', "O'zбек тормоз"],
    ['a single stray Cyrillic letter', 'Tormoz kolodkalaри'],
  ])('rejects %s', (_label, value) => {
    expect(isUzbekLatin(value)).toBe(false);
  });

  it.each([
    ['Arabic', 'قطع غيار'],
    ['Greek', 'Φρένα'],
    ['CJK', '刹车片'],
  ])('rejects %s, not just Cyrillic', (_label, value) => {
    expect(isUzbekLatin(value)).toBe(false);
  });
});

describe('isUzbekLatin — non-names', () => {
  it.each([
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['digits with no letter', '123'],
    ['punctuation with no letter', '---'],
  ])('rejects %s (a name needs a letter)', (_label, value) => {
    expect(isUzbekLatin(value)).toBe(false);
  });

  // Type errors are `@IsString()`'s to report; this predicate answers only
  // "is this string Uzbek Latin", so a non-string is simply false, never a throw.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an object', { nameUz: 'Tormoz' }],
  ])('returns false for %s without throwing', (_label, value) => {
    expect(() => isUzbekLatin(value)).not.toThrow();
    expect(isUzbekLatin(value)).toBe(false);
  });

  it('ignores surrounding whitespace rather than failing on it', () => {
    expect(isUzbekLatin('  Tormoz kolodkalari  ')).toBe(true);
  });

  // A decomposed sequence renders identically to its composed form; judging it
  // by the combining mark would reject a name that LOOKS perfectly valid.
  it('normalizes to NFC before judging the characters', () => {
    const decomposed = 'Mätor'.normalize('NFD');
    expect(isUzbekLatin(decomposed)).toBe(isUzbekLatin(decomposed.normalize('NFC')));
  });
});

describe('normalizeUzbekApostrophes', () => {
  it('folds every accepted form to one canonical apostrophe', () => {
    for (const form of ["'", '‘', '’', 'ʻ', 'ʼ', '`', '´']) {
      expect(normalizeUzbekApostrophes(`Yog${form}`)).toBe(
        `Yog${UZBEK_APOSTROPHE}`,
      );
    }
  });

  it('makes two spellings of the same name compare equal', () => {
    expect(normalizeUzbekApostrophes("O'zbekiston")).toBe(
      normalizeUzbekApostrophes('Oʻzbekiston'),
    );
  });

  it('leaves a name with no apostrophe untouched', () => {
    expect(normalizeUzbekApostrophes('Tormoz tizimi')).toBe('Tormoz tizimi');
  });
});
