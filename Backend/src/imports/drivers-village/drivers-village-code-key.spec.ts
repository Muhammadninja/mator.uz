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
  it('accepts every code shape the export carries', () => {
    for (const code of [
      '96273708',
      '96273708 GMB',
      'GMB 96273708',
      '02E-409-359',
      '00-00001431',
      '12605566pmc',
      'A-1',
    ])
      expect(code1cIssue(code)).toBeNull();
  });

  it('names why a code is refused', () => {
    expect(code1cIssue(null)?.code).toBe('empty_code_1c');
    expect(code1cIssue('')?.code).toBe('empty_code_1c');
    expect(code1cIssue('БП 010')?.code).toBe('invalid_code_1c'); // no article
    expect(code1cIssue('96273708  GMB')?.code).toBe('invalid_code_1c');
    expect(code1cIssue('A&B')?.code).toBe('invalid_code_1c');
    expect(code1cIssue('9'.repeat(65))?.code).toBe('invalid_code_1c');
    expect(code1cIssue('3333')?.code).toBe('placeholder_code_1c');
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
  const outcome = (file: string, stored: string) => {
    const r = resolveCodeKeys([file], [stored]);
    if (r.matches.has(file)) return 'takes over';
    if (r.conflicts.has(file)) return 'conflict';
    return r.shared.has(file) ? 'own position, key reported' : 'own position';
  };

  it('the key proves one part only between the bare article and the article with a marker', () => {
    expect(
      [
        ['96273708 GMB', '96273708'], // marker added
        ['96273708', '96273708 GMB'], // marker dropped
        ['GMB 96273708', '96273708'],
        ['96273708 OEM', '96273708 GMB'], // marker replaced: not proven
        ['БП-00001431', '00-00001431'], // another 1C series: not proven
        ['GMB 96273708', '96273708-HN'],
      ].map(([file, stored]) => [file, stored, outcome(file, stored)]),
    ).toEqual([
      ['96273708 GMB', '96273708', 'takes over'],
      ['96273708', '96273708 GMB', 'takes over'],
      ['GMB 96273708', '96273708', 'takes over'],
      ['96273708 OEM', '96273708 GMB', 'own position, key reported'],
      ['БП-00001431', '00-00001431', 'own position, key reported'],
      ['GMB 96273708', '96273708-HN', 'own position, key reported'],
    ]);
    expect(
      resolveCodeKeys(['96273708 OEM'], ['96273708 GMB']).shared.get(
        '96273708 OEM',
      ),
    ).toEqual({
      key: '96273708',
      fileCodes: [],
      storedCodes: ['96273708 GMB'],
    });
  });

  it('an exact code keeps its own position; a code without a key is never matched', () => {
    const r = resolveCodeKeys(
      ['96273708', '5Q0-615-301-G', '1234567890-A'],
      ['96273708', '96273708-HN', '5Q0-615-301-F', '1234567890'],
    );
    expect(r.matches.size + r.conflicts.size + r.shared.size).toBe(0);
  });

  it('a provable takeover with rivals is a conflict: several stored positions, or several codes of the file', () => {
    expect(
      resolveCodeKeys(['96273708 OEM'], ['96273708', '96273708-HN']).conflicts,
    ).toEqual(
      new Map([
        [
          '96273708 OEM',
          {
            key: '96273708',
            codes: ['96273708 OEM'],
            storedCodes: ['96273708', '96273708-HN'],
          },
        ],
      ]),
    );
    const two = resolveCodeKeys(['96273708 GMB', '96273708 OEM'], ['96273708']);
    expect([...two.conflicts.keys()]).toEqual(['96273708 GMB', '96273708 OEM']);
    // Without a provable takeover there is nothing to resolve: own positions.
    const none = resolveCodeKeys(
      ['96273708 OEM'],
      ['96273708 GMB', '96273708-HN'],
    );
    expect(none.conflicts.size + none.matches.size).toBe(0);
    expect(none.shared.get('96273708 OEM')?.storedCodes).toEqual([
      '96273708 GMB',
      '96273708-HN',
    ]);
  });

  it('with no stored position to take over, codes sharing a key are separate positions', () => {
    for (const stored of [[], ['96273708']]) {
      const r = resolveCodeKeys(['96273708', '96273708 GMB'], stored);
      expect(r.matches.size + r.conflicts.size).toBe(0);
      expect(r.shared.get('96273708 GMB')).toEqual({
        key: '96273708',
        fileCodes: ['96273708'],
        storedCodes: [],
      });
    }
  });

  it('the key joins the OEM index only when no other position carries that value', () => {
    const keyOf = (file: string[], stored: string[], code: string) =>
      resolveCodeKeys(file, stored).searchKeys.get(code);
    expect(keyOf(['96273708 GMB'], [], '96273708 GMB')).toBe('96273708');
    // A takeover: the stored position becomes this code's own.
    expect(keyOf(['96273708 GMB'], ['96273708'], '96273708 GMB')).toBe(
      '96273708',
    );
    for (const [file, stored] of [
      [['96273708', '96273708 GMB'], []], // the bare article holds it
      [['96273708 OEM'], ['96273708 GMB']], // not taken over
      [['96273708 GMB'], ['96.273.708']], // the same normalized number
      [['96273708 GMB', '96273708 OEM'], ['96273708']], // a conflict
    ])
      expect(keyOf(file, stored, file[file.length - 1])).toBeUndefined();
  });
});
