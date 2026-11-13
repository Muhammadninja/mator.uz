import { normalizeOem } from './normalize-oem.util';
import {
  MAX_PART_NUMBER_LENGTH,
  compareIdentifiers,
  hasDroppedCharacters,
  hasLeadingZero,
  identifierKey,
  literalNumberForms,
  parsePartNumber,
  partNumberKey,
  partNumbersInText,
} from './part-number.util';

describe('parsePartNumber — when a text is a part number', () => {
  it('keeps leading zeros: identifiers are strings, never numbers', () => {
    expect(partNumberKey('09593992')).toBe('09593992');
    expect(partNumberKey('0986452041')).toBe('0986452041');
    expect(partNumberKey('09593992')).not.toBe(partNumberKey('9593992'));
  });

  it('folds case', () => {
    expect(partNumberKey('sp-1362')).toBe('SP1362');
    expect(partNumberKey('Sp-1362')).toBe(partNumberKey('SP-1362'));
  });

  it('drops spaces, hyphens, dots, slashes and underscores between characters', () => {
    expect(partNumberKey('SP 1362')).toBe('SP1362');
    expect(partNumberKey('96.943.770')).toBe('96943770');
    expect(partNumberKey('2108-1001234')).toBe('21081001234');
    expect(partNumberKey('A/B_12')).toBe('AB12');
    // Edge separators are noise, not part of the number.
    expect(partNumberKey('  96.943.770. ')).toBe('96943770');
  });

  it('keeps the original text as given (trimmed), never rewritten', () => {
    const parsed = parsePartNumber('  sp-1362 ');
    expect(parsed).toEqual({
      ok: true,
      value: { original: 'sp-1362', canonical: 'SP1362' },
    });
  });

  it('agrees with the stored canonical form (normalizeOem) on every accepted text', () => {
    for (const text of [
      'sp-1362',
      '96.943.770',
      '0986 452 041',
      'GM-96879797',
    ]) {
      expect(partNumberKey(text)).toBe(normalizeOem(text));
    }
  });

  it('numbers that differ by one digit stay different', () => {
    expect(partNumberKey('96879797')).not.toBe(partNumberKey('96879798'));
    expect(partNumberKey('96-879-797')).not.toBe(partNumberKey('96-879-79'));
  });

  it('rejects empty text', () => {
    for (const text of ['', '   ', '---', ' . / ', null, undefined]) {
      expect(parsePartNumber(text)).toEqual({ ok: false, reason: 'empty' });
    }
  });

  it('rejects text normalizeOem would have to delete letters from', () => {
    // normalizeOem drops these silently and would invent another number.
    expect(normalizeOem('ВАЗ 2106')).toBe('2106');
    expect(normalizeOem('А123')).toBe('123'); // Cyrillic А
    for (const text of [
      'ВАЗ 2106',
      'А123',
      'Нексия 3',
      'фильтр',
      '96879797!',
      '5W-30 масло',
    ]) {
      expect(parsePartNumber(text)).toEqual({
        ok: false,
        reason: 'unsupported_characters',
      });
      expect(partNumberKey(text)).toBeNull();
    }
  });

  it('treats a run of separators inside a number as one separator', () => {
    expect(partNumberKey('SP--1362')).toBe('SP1362');
    expect(partNumberKey('SP - 1362')).toBe('SP1362');
  });

  it('rejects an over-long number', () => {
    const long = '1'.repeat(MAX_PART_NUMBER_LENGTH + 1);
    expect(parsePartNumber(long)).toEqual({ ok: false, reason: 'too_long' });
    expect(partNumberKey('1'.repeat(MAX_PART_NUMBER_LENGTH))).not.toBeNull();
  });
});

describe('partNumbersInText — the numbers a search text names', () => {
  it('the whole text when it is a number', () => {
    expect(partNumbersInText('SP 1362')).toEqual(['SP1362']);
    expect(partNumbersInText('09593992')).toEqual(['09593992']);
  });

  it('a word is never a number (no digit)', () => {
    expect(partNumbersInText('pads')).toEqual([]);
    expect(partNumbersInText('фильтр')).toEqual([]);
  });

  it('a long number beside words is found, a short one is not', () => {
    expect(partNumbersInText('масляный фильтр 96879797')).toEqual(['96879797']);
    expect(partNumbersInText('ВАЗ 2106')).toEqual([]);
    expect(partNumbersInText('Нексия 3 колодки')).toEqual([]);
  });

  it('a piece with a non-Latin look-alike letter is not a number', () => {
    expect(partNumbersInText('фильтр А123456')).toEqual([]);
  });

  it('lists each number once', () => {
    expect(partNumbersInText('96879797 или 96-879-797')).toEqual(['96879797']);
  });
});

describe('literalNumberForms — exact stored spellings to try', () => {
  it('the text as typed and its uppercase', () => {
    expect(literalNumberForms(' sp-1362 ')).toEqual(['sp-1362', 'SP-1362']);
    expect(literalNumberForms('96879797')).toEqual(['96879797']);
  });

  it('allows a stored spelling with Cyrillic, which exact equality cannot invent', () => {
    expect(literalNumberForms('ЗМЗ-406')).toEqual(['ЗМЗ-406']);
  });

  it('nothing for a plain word or an empty text', () => {
    expect(literalNumberForms('фильтр')).toEqual([]);
    expect(literalNumberForms('')).toEqual([]);
  });
});

describe('stored-number diagnostics', () => {
  it('flags characters normalizeOem would drop', () => {
    expect(hasDroppedCharacters('ЗМЗ-406')).toBe(true);
    expect(hasDroppedCharacters('SP-1362')).toBe(false);
  });

  it('flags a leading zero', () => {
    expect(hasLeadingZero('09593992')).toBe(true);
    expect(hasLeadingZero('9593992')).toBe(false);
    expect(hasLeadingZero('0')).toBe(false);
  });
});

describe('compareIdentifiers — normalization never implies equivalence', () => {
  const bosch = (original: string) =>
    ({ scheme: 'OEM', manufacturer: 'Bosch', original }) as const;

  it('same spelling, scheme and manufacturer → identical', () => {
    expect(compareIdentifiers(bosch('SP-1362'), bosch('SP-1362'))).toBe(
      'identical',
    );
  });

  it('same manufacturer, written differently → a format variant of one number', () => {
    expect(compareIdentifiers(bosch('SP-1362'), bosch('sp 1362'))).toBe(
      'format_variant',
    );
  });

  it('different manufacturers with one canonical form → a collision, not the same part', () => {
    expect(
      compareIdentifiers(bosch('SP-1362'), {
        scheme: 'OEM',
        manufacturer: 'Denso',
        original: 'SP1362',
      }),
    ).toBe('collision');
  });

  it('an unknown manufacturer cannot be shown to match → collision', () => {
    expect(
      compareIdentifiers(bosch('SP1362'), {
        scheme: 'OEM',
        manufacturer: null,
        original: 'SP1362',
      }),
    ).toBe('collision');
  });

  it('a GM number and an OEM number with one form → collision', () => {
    expect(
      compareIdentifiers(
        { scheme: 'GM', manufacturer: 'GM', original: '96879797' },
        { scheme: 'OEM', manufacturer: 'GM', original: '96879797' },
      ),
    ).toBe('collision');
  });

  it('one digit apart, or a dropped leading zero → different', () => {
    expect(compareIdentifiers(bosch('96879797'), bosch('96879798'))).toBe(
      'different',
    );
    expect(compareIdentifiers(bosch('0986452041'), bosch('986452041'))).toBe(
      'different',
    );
  });

  it('identifierKey keeps the owner: one number, two manufacturers, two keys', () => {
    const a = identifierKey(bosch('SP-1362'));
    const b = identifierKey({
      scheme: 'OEM',
      manufacturer: 'Denso',
      original: 'SP1362',
    });
    expect(a).not.toBe(b);
    expect(identifierKey(bosch('sp 1362'))).toBe(a);
  });
});
