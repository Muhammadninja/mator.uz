/**
 * The 8-digit key of code_1c and how the codes of a file are resolved
 * against the stored ones — pure functions. End to end through the importer:
 * drivers-village-code-key-import.spec.ts.
 */
import {
  code1cIssue,
  eightDigitKey,
  keyProvesSamePart,
  resolveCodeKeys,
} from './drivers-village-code-key';

describe('code1cIssue — the one code_1c rule (importer and Telegram captions)', () => {
  it('accepts every code shape the export carries, as before', () => {
    for (const code of [
      '96273708',
      '96273708 GMB',
      'GMB 96273708',
      '02E-409-359',
      '00-00001431',
      '12605566pmc',
      'A-1',
      // 1C marks separate positions with a leading underscore or trailing
      // dashes: accepted before, so stored positions keep matching.
      '_БП-01074259',
      '93186310-',
      '96980048 OEM--',
      'Аптечка',
      '93745368-кпвк-1625т200',
    ])
      expect(code1cIssue(code)).toBeNull();
  });

  it('accepts articles of letters, digits, single spaces and hyphens — not only numbers', () => {
    for (const code of [
      'SCT SB 061-0868',
      'VIX A 6007',
      'K0000049 H6',
      'PFA 235',
      'PFA 235-',
      'Stark SFA 4004',
      '12140-78B00-025 OEM',
      // & + and balanced parentheses inside an article
      '94583379S&T',
      '96273708PMC(EU)',
      '4260360943454 12+',
      'АФГ94582132&94582135&94582157',
    ])
      expect([code, code1cIssue(code)]).toEqual([code, null]);
  });

  it('names why a code is refused', () => {
    const reason = (code: string | null) => code1cIssue(code)?.code;
    expect(reason(null)).toBe('empty_code_1c');
    expect(reason('')).toBe('empty_code_1c');
    // Irregular whitespace is never collapsed into another code.
    expect(reason('96273708  GMB')).toBe('invalid_code_1c');
    expect(reason('847GPUMPT   90231')).toBe('invalid_code_1c');
    expect(reason('SCT\tSB 061-0868')).toBe('invalid_code_1c');
    expect(reason('SCT\u00a0SB 061-0868')).toBe('invalid_code_1c');
    // Other punctuation and unbalanced parentheses.
    expect(reason('RXA06820 ,')).toBe('invalid_code_1c');
    expect(reason('Шина 195\\60 R14')).toBe('invalid_code_1c');
    expect(reason('96273708PMC(EU')).toBe('invalid_code_1c');
    expect(reason('9'.repeat(65))).toBe('invalid_code_1c');
    // A product name in the code column is no article.
    expect(reason('Фильтр топливного насоса')).toBe('name_as_code_1c');
    expect(reason('Аккумуляторные батареи марки KLAS N')).toBe(
      'name_as_code_1c',
    );
    expect(reason('Шина 235/55/R19')).toBe('name_as_code_1c');
    expect(reason('Castrol EDGE')).toBe('name_as_code_1c');
    // Placeholders: one character repeated — a rule of its own.
    expect(reason('3333')).toBe('placeholder_code_1c');
    expect(reason('3333333')).toBe('placeholder_code_1c');
  });
});

describe('keyProvesSamePart', () => {
  it('holds only between the bare article and the article with a marker', () => {
    expect(keyProvesSamePart('96273708', '96273708 GMB')).toBe(true);
    expect(keyProvesSamePart('GMB 96273708', '96273708')).toBe(true);
    expect(keyProvesSamePart('96273708 OEM', '96273708 GMB')).toBe(false);
    expect(keyProvesSamePart('БП-00001431', '00-00001431')).toBe(false);
    expect(keyProvesSamePart('96273708', '96273709 GMB')).toBe(false);
    expect(keyProvesSamePart('123456789', '123456789 GMB')).toBe(false);
  });
});

describe('eightDigitKey', () => {
  it('is the one run of exactly 8 digits, before or after a marker', () => {
    for (const code of [
      '96273708',
      '96273708 GMB',
      '96273708 OEM',
      'GMB 96273708',
      '96273708-OEM',
      '96273708GMB',
      'GM96273708',
    ])
      expect(eightDigitKey(code)).toBe('96273708');
    expect(eightDigitKey('_00-00001431')).toBe('00001431');
  });

  it('is never cut out of a longer run, and needs exactly one 8-digit run', () => {
    for (const code of [
      '123456789',
      '1234567890',
      '9627370896273709',
      '1234567',
      '96273708 96273709',
      '5Q0-615-301-F',
      'БП-010',
      '',
    ])
      expect(eightDigitKey(code)).toBeNull();
  });

  it('a non-ASCII digit extends the run; only ASCII digits make a key', () => {
    expect(eightDigitKey('96273708٣')).toBeNull(); // Arabic-Indic 3: 9 digits
    expect(eightDigitKey('９６２７３７０８')).toBeNull(); // full-width
  });
});

describe('resolveCodeKeys', () => {
  it('a code without a position of its own is a new position: a key it shares is reported, never taken over', () => {
    const share = (file: string, stored: string) =>
      resolveCodeKeys([file], [stored]).shared.get(file);
    expect(share('96273708 GMB', '96273708')).toEqual({
      key: '96273708',
      fileCodes: [],
      storedCodes: ['96273708'],
      possibleRenameOf: ['96273708'], // marker added: maybe renamed in 1C
    });
    expect(share('96273708', '96273708 GMB')?.possibleRenameOf).toEqual([
      '96273708 GMB',
    ]);
    // A marker is often another brand: reported the same way, never merged.
    expect(share('96273708PMC(EU)', '96273708')?.possibleRenameOf).toEqual([
      '96273708',
    ]);
    for (const [file, stored] of [
      ['96273708 OEM', '96273708 GMB'], // marker replaced
      ['БП-00001431', '00-00001431'], // another 1C series
      ['GMB 96273708', '96273708-HN'],
    ])
      expect(share(file, stored)).toEqual({
        key: eightDigitKey(file),
        fileCodes: [],
        storedCodes: [stored],
        possibleRenameOf: [],
      });
  });

  it('an exact code keeps its own position; a code without a key is never related', () => {
    const r = resolveCodeKeys(
      ['96273708', '5Q0-615-301-G', '1234567890-A'],
      ['96273708', '96273708-HN', '5Q0-615-301-F', '1234567890'],
    );
    expect(r.shared.size).toBe(0);
  });

  it('codes of one file sharing a key are separate positions', () => {
    for (const stored of [[], ['96273708']]) {
      const r = resolveCodeKeys(['96273708', '96273708 GMB'], stored);
      expect(r.shared.get('96273708 GMB')).toEqual({
        key: '96273708',
        fileCodes: ['96273708'],
        storedCodes: [],
        possibleRenameOf: [],
      });
    }
  });

  it('the key joins the OEM index only when no other position carries that value', () => {
    const keyOf = (file: string[], stored: string[], code: string) =>
      resolveCodeKeys(file, stored).searchKeys.get(code);
    expect(keyOf(['96273708 GMB'], [], '96273708 GMB')).toBe('96273708');
    for (const [file, stored] of [
      [['96273708 GMB'], ['96273708']], // the stored bare article holds it
      [['96273708', '96273708 GMB'], []], // the bare article in the file
      [['96273708 OEM'], ['96273708 GMB']],
      [['96273708 GMB'], ['96.273.708']], // the same normalized number
    ])
      expect(keyOf(file, stored, file[file.length - 1])).toBeUndefined();
  });

  it('codes with the same search number stay separate positions and are reported', () => {
    const r = resolveCodeKeys(['PFA 235-', 'PFA-235', 'PFA 236'], ['PFA 235']);
    expect(r.sameSearchNumber.get('PFA 235-')).toEqual(['PFA 235', 'PFA-235']);
    expect(r.sameSearchNumber.get('PFA-235')).toEqual(['PFA 235', 'PFA 235-']);
    expect(r.sameSearchNumber.has('PFA 236')).toBe(false);
    // A stored position updated by its own code is never reported.
    expect(
      resolveCodeKeys(['PFA 235'], ['PFA 235', 'PFA 235-']).sameSearchNumber
        .size,
    ).toBe(0);
    // A stored code may carry the number as its 8-digit key (indexed when it
    // was created); a file code's shared key is never indexed.
    expect(
      resolveCodeKeys(['96273708'], ['96273708 GMB']).sameSearchNumber.get(
        '96273708',
      ),
    ).toEqual(['96273708 GMB']);
    expect(
      resolveCodeKeys(['96273708', '96273708 GMB'], []).sameSearchNumber.size,
    ).toBe(0);
  });
});
