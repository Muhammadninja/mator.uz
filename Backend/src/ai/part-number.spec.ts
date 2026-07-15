import { classifyPartNumberType, splitPartNumber } from './part-number';

describe('classifyPartNumberType', () => {
  it('returns GM when the text carries a GM label only', () => {
    expect(classifyPartNumberType('Фара GM 96535062', '96535062')).toBe('GM');
    expect(classifyPartNumberType('Фара ГМ 96535062', '96535062')).toBe('GM');
  });

  it('returns OEM when the text carries an OEM label only', () => {
    expect(classifyPartNumberType('Фильтр OEM 96535062', '96535062')).toBe('OEM');
    expect(classifyPartNumberType('Фильтр ОЕМ 96535062', '96535062')).toBe('OEM');
  });

  it('returns UNKNOWN for an unlabeled number (bare digits / Артикул / Part No.)', () => {
    expect(classifyPartNumberType('Фильтр 96535062', '96535062')).toBe('UNKNOWN');
    expect(classifyPartNumberType('Фильтр Артикул 96535062', '96535062')).toBe('UNKNOWN');
    expect(classifyPartNumberType('Filter Part No. 96535062', '96535062')).toBe('UNKNOWN');
  });

  it('returns UNKNOWN when BOTH labels appear (ambiguous — never picks a side)', () => {
    expect(classifyPartNumberType('GM/OEM 96535062', '96535062')).toBe('UNKNOWN');
  });

  it('returns UNKNOWN when there is no number to classify', () => {
    expect(classifyPartNumberType('Фара GM оригинал', null)).toBe('UNKNOWN');
    expect(classifyPartNumberType('Фара OEM', undefined)).toBe('UNKNOWN');
  });

  it('does not match GM/OEM inside another word', () => {
    // "магнитола" contains no standalone gm; "gmc" would, but здесь проверяем,
    // что случайная подстрока не срабатывает.
    expect(classifyPartNumberType('огм 96535062', '96535062')).toBe('UNKNOWN');
  });

  it('never infers the type from the number itself', () => {
    // An 11-digit "canonical GM length" number with no label is still UNKNOWN.
    expect(classifyPartNumberType('Фара 96549774112', '96549774112')).toBe('UNKNOWN');
  });

  // ── The label must be ATTACHED TO A NUMBER — a marketing phrase is not one ──
  it('a marketing/quality phrase (label not attached to the number) → UNKNOWN', () => {
    // "OEM quality"/"GM compatible" describe the product; the number is separate.
    expect(classifyPartNumberType('Колодки OEM quality 93745764', '93745764')).toBe('UNKNOWN');
    expect(classifyPartNumberType('Фильтр GM compatible для авто 93745764', '93745764')).toBe('UNKNOWN');
  });

  it('accepts label connectors between the label and the number', () => {
    expect(classifyPartNumberType('OEM: 93745764', '93745764')).toBe('OEM');
    expect(classifyPartNumberType('OEM No. 93745764', '93745764')).toBe('OEM');
    expect(classifyPartNumberType('OEM Number: 93745764', '93745764')).toBe('OEM');
    expect(classifyPartNumberType('OEM № 93745764', '93745764')).toBe('OEM');
    expect(classifyPartNumberType('OEM Part Number 93745764', '93745764')).toBe('OEM');
    expect(classifyPartNumberType('GM: 96440756', '96440756')).toBe('GM');
    expect(classifyPartNumberType('масло GM 96440756', '96440756')).toBe('GM');
  });

  it('a combined GM/OEM (or OEM/GM) label is ambiguous → UNKNOWN', () => {
    expect(classifyPartNumberType('GM/OEM 93745764', '93745764')).toBe('UNKNOWN');
    expect(classifyPartNumberType('OEM/GM: 93745764', '93745764')).toBe('UNKNOWN');
  });

  it('the required GM oil example resolves to GM (label attached to a number)', () => {
    // "масло GM 100% … 93745764": "GM 100" is a GM label attached to a number, and
    // "оригинал"/"original" (authenticity) never counts.
    expect(
      classifyPartNumberType(
        'Оригинальное синтетическое масло GM DEXOS-2 Масло GM 100% синтетическое. 93745764',
        '93745764',
      ),
    ).toBe('GM');
  });
});

describe('splitPartNumber (no cross-copy)', () => {
  it('GM → gmNumber only, oemNumber null', () => {
    expect(splitPartNumber('96535062', 'GM')).toEqual({
      gmNumber: '96535062',
      oemNumber: null,
    });
  });

  it('OEM → oemNumber only, gmNumber null', () => {
    expect(splitPartNumber('96535062', 'OEM')).toEqual({
      gmNumber: null,
      oemNumber: '96535062',
    });
  });

  it('UNKNOWN keeps the value in gmNumber (the unique key), oemNumber null', () => {
    expect(splitPartNumber('96535062', 'UNKNOWN')).toEqual({
      gmNumber: '96535062',
      oemNumber: null,
    });
  });

  it('a null number yields both null for every type', () => {
    for (const t of ['GM', 'OEM', 'UNKNOWN'] as const) {
      expect(splitPartNumber(null, t)).toEqual({ gmNumber: null, oemNumber: null });
    }
  });
});
