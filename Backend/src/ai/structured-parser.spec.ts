import { parseStructuredCaption, splitParagraphs } from './structured-parser';

describe('splitParagraphs', () => {
  it('splits on blank lines and trims each paragraph', () => {
    const input = 'Title line\n\nDescription line\n\n96234567\n\n450000';
    expect(splitParagraphs(input)).toEqual([
      'Title line',
      'Description line',
      '96234567',
      '450000',
    ]);
  });

  it('treats multiple blank lines as a single separator', () => {
    expect(splitParagraphs('A\n\n\n\nB')).toEqual(['A', 'B']);
  });

  it('collapses duplicate spaces but preserves the words', () => {
    expect(splitParagraphs('Магнитола   BOSCH   для  Nexia 3')).toEqual([
      'Магнитола BOSCH для Nexia 3',
    ]);
  });

  it('ignores leading/trailing blank lines', () => {
    expect(splitParagraphs('\n\nTitle\n\nDesc\n\n')).toEqual(['Title', 'Desc']);
  });

  it('splits on SINGLE newlines (official format) — one field per line', () => {
    expect(splitParagraphs('Title line\nDescription line\n96234567\n450000')).toEqual([
      'Title line',
      'Description line',
      '96234567',
      '450000',
    ]);
  });

  it('normalizes single-newline and blank-line inputs to the SAME array', () => {
    const single = splitParagraphs('Title\nDesc\n96234567\n450000');
    const blank = splitParagraphs('Title\n\nDesc\n\n96234567\n\n450000');
    expect(single).toEqual(blank);
    expect(single).toEqual(['Title', 'Desc', '96234567', '450000']);
  });

  it('ignores mixed and trailing empty lines', () => {
    expect(splitParagraphs('Title\n\nDesc\n96234567\n\n\n450000\n\n')).toEqual([
      'Title',
      'Desc',
      '96234567',
      '450000',
    ]);
  });

  it('normalizes CRLF single-newline input', () => {
    expect(splitParagraphs('Title\r\nDesc\r\n96234567\r\n450000')).toEqual([
      'Title',
      'Desc',
      '96234567',
      '450000',
    ]);
  });
});

describe('parseStructuredCaption', () => {
  it('parses the full 4-paragraph format', () => {
    const r = parseStructuredCaption(
      'Магнитола для Nexia 3\n\nПроизводство Корея, новая\n\n96234567\n\n450000',
    );
    expect(r).toEqual({
      title: 'Магнитола для Nexia 3',
      description: 'Производство Корея, новая',
      brand: 'Chevrolet',
      models: ['Nexia 3'],
      gm_number: '96234567',
      price: 450000,
    });
  });

  it('preserves the title EXACTLY — make/model are detected but NOT removed', () => {
    const r = parseStructuredCaption(
      'Магнитола BOSCH для Nexia 3\n\nновая\n\n96234567\n\n450000',
    );
    // Title kept verbatim, including "BOSCH", "для", and the model name.
    expect(r?.title).toBe('Магнитола BOSCH для Nexia 3');
    // Vehicle fields still populated independently.
    expect(r?.brand).toBe('Chevrolet');
    expect(r?.models).toEqual(['Nexia 3']);
  });

  it('does not move text between title and description', () => {
    const r = parseStructuredCaption(
      'Фильтр масляный оригинал\n\nПроизводство Корея',
    );
    // "оригинал" (a condition word) stays in the title, not moved to description.
    expect(r?.title).toBe('Фильтр масляный оригинал');
    expect(r?.description).toBe('Производство Корея');
  });

  it('accepts title + description with no OEM/price paragraphs', () => {
    const r = parseStructuredCaption(
      'Магнитола BOSCH для Nexia 3\n\nПроизводство Корея, новая',
    );
    expect(r?.title).toBe('Магнитола BOSCH для Nexia 3');
    expect(r?.description).toBe('Производство Корея, новая');
    expect(r?.gm_number).toBeNull();
    expect(r?.price).toBeNull();
  });

  it('parses a price paragraph that carries a currency word', () => {
    const r = parseStructuredCaption(
      'Тормозные колодки\n\nкомплект\n\n1605264\n\n120000 сум',
    );
    expect(r?.gm_number).toBe('1605264');
    expect(r?.price).toBe(120000);
  });

  it('returns null for a single-paragraph caption (falls back)', () => {
    expect(
      parseStructuredCaption('Фильтр масла Cobalt оригинал 96535062 25000 сум'),
    ).toBeNull();
  });

  it('folds a non-OEM 3rd line into the description (official format is lenient)', () => {
    const r = parseStructuredCaption('Магнитола\nописание\nэто не номер вовсе\n450000');
    expect(r?.title).toBe('Магнитола');
    // The non-field line joins the description; the price line is still detected.
    expect(r?.description).toBe('описание это не номер вовсе');
    expect(r?.gm_number).toBeNull();
    expect(r?.price).toBe(450000);
  });

  it('folds a non-price trailing line into the description', () => {
    const r = parseStructuredCaption('Магнитола\nописание\n96234567\nне цена совсем');
    expect(r?.title).toBe('Магнитола');
    expect(r?.gm_number).toBe('96234567');
    expect(r?.price).toBeNull();
    expect(r?.description).toBe('описание не цена совсем');
  });

  it('folds additional lines (5+) after price into the description, keeping GM/price', () => {
    // Official positions: 1=title, 2=desc, 3=GM, 4=price, 5+=extra description.
    const r = parseStructuredCaption('A part\nописание\n96234567\n450000\nещё детали');
    expect(r?.title).toBe('A part');
    expect(r?.gm_number).toBe('96234567');
    expect(r?.price).toBe(450000);
    expect(r?.description).toBe('описание ещё детали');
  });
});

describe('parseStructuredCaption — highest-priority 11-digit exception', () => {
  // Rule: when line 3 is a valid 11-digit GM AND line 4 is a valid price, take
  // GM/price DIRECTLY from lines 3 & 4; do not extract them from title/desc.
  it('uses GM and price directly from lines 3 & 4 (11-digit GM)', () => {
    const r = parseStructuredCaption(
      'Фара передняя Cobalt\n\nОригинал, Корея\n\n96549774112\n\n350000 сум',
    );
    expect(r?.title).toBe('Фара передняя Cobalt');
    expect(r?.description).toBe('Оригинал, Корея');
    expect(r?.gm_number).toBe('96549774112'); // line 3, verbatim 11 digits
    expect(r?.price).toBe(350000); // line 4
    expect(r?.brand).toBe('Chevrolet'); // make/model still from title
    expect(r?.models).toEqual(['Cobalt']);
  });

  it('does NOT take GM/price from the title even if the title also has numbers', () => {
    // Title carries a stray 8-digit code and a price-like number; they must be
    // IGNORED because lines 3 & 4 already supply the authoritative GM/price.
    const r = parseStructuredCaption(
      'Фара 12345678 за 999999\n\nописание\n\n96549774112\n\n350000',
    );
    expect(r?.gm_number).toBe('96549774112'); // from line 3, NOT the title's 12345678
    expect(r?.price).toBe(350000); // from line 4, NOT the title's 999999
  });

  it('detects make/model from the DESCRIPTION when the title lacks them', () => {
    const r = parseStructuredCaption(
      'Магнитола\n\nChevrolet Cobalt новая\n\n96549774112\n\n200000 сум',
    );
    expect(r?.brand).toBe('Chevrolet'); // recovered from line 2 (description)
    expect(r?.models).toContain('Cobalt');
    expect(r?.gm_number).toBe('96549774112');
    expect(r?.price).toBe(200000);
  });

  it('parses the price via the improved parser (130.000 → 130000)', () => {
    const r = parseStructuredCaption(
      'Деталь Cobalt\n\nописание\n\n96549774112\n\n130.000',
    );
    expect(r?.price).toBe(130000); // dot = thousands separator
  });

  it('accepts the newer currency variants on line 4', () => {
    for (const cur of ["so'm", 'soʻm', 'сўм', 'сoʻм', 'UZS']) {
      const r = parseStructuredCaption(
        `Деталь Cobalt\n\nописание\n\n96549774112\n\n350000 ${cur}`,
      );
      expect(r?.price).toBe(350000);
      expect(r?.gm_number).toBe('96549774112');
    }
  });

  it('does NOT fire the exception when line 3 is only 8 digits (falls back)', () => {
    // 8-digit line 3 is not the strict 11-digit GM, so the normal lenient
    // positional parser handles it (and still detects the 8-digit GM).
    const r = parseStructuredCaption('Магнитола\n\nописание\n\n96234567\n\n450000');
    expect(r?.gm_number).toBe('96234567'); // lenient positional path, unchanged
    expect(r?.price).toBe(450000);
  });

  it('does NOT fire the exception when line 4 is not a valid price', () => {
    // Line 3 is a valid 11-digit GM but line 4 is prose → exception off; the
    // lenient positional parser still keeps the 11-digit GM and folds line 4 in.
    const r = parseStructuredCaption('Магнитола\n\nописание\n\n96549774112\n\nне цена');
    expect(r?.gm_number).toBe('96549774112'); // still detected positionally
    expect(r?.price).toBeNull();
    expect(r?.description).toContain('не цена');
  });

  it('does NOT treat a merged "GM price" line 3 as the exception', () => {
    // Line 3 has TWO numbers; it is not a clean bare 11-digit GM, so the strict
    // exception does not fire (guards against a mis-shaped listing).
    const r = parseStructuredCaption(
      'Фара Cobalt\n\nописание\n\n96549774112 350000\n\n999',
    );
    // The exception must not have fired with gm=11-digit + price=999; the strict
    // GM guard rejects the two-number line 3.
    expect(r?.gm_number === '96549774112' && r?.price === 999).toBe(false);
  });
});

describe('parseStructuredCaption — labeled formats', () => {
  const EXPECTED = {
    title: 'Магнитола для Nexia 3',
    description: 'Производство Корея, новая',
    brand: 'Chevrolet',
    models: ['Nexia 3'],
    gm_number: '96234567',
    price: 450000,
  };

  it('Format 2: labels on the same line as their value', () => {
    const r = parseStructuredCaption(
      'Название: Магнитола для Nexia 3\n\n' +
        'Описание: Производство Корея, новая\n\n' +
        'GM: 96234567\n\n' +
        'Цена: 450000',
    );
    expect(r).toEqual(EXPECTED);
  });

  it('Format 3: label alone with the value in the next paragraph', () => {
    const r = parseStructuredCaption(
      'Название\n\nМагнитола для Nexia 3\n\n' +
        'Описание\n\nПроизводство Корея, новая\n\n' +
        'GM\n\n96234567\n\n' +
        'Цена\n\n450000',
    );
    expect(r).toEqual(EXPECTED);
  });

  it('all three formats yield the same result', () => {
    const plain = parseStructuredCaption(
      'Магнитола для Nexia 3\n\nПроизводство Корея, новая\n\n96234567\n\n450000',
    );
    const sameLine = parseStructuredCaption(
      'Название: Магнитола для Nexia 3\n\nОписание: Производство Корея, новая\n\nGM: 96234567\n\nЦена: 450000',
    );
    const nextLine = parseStructuredCaption(
      'Название\n\nМагнитола для Nexia 3\n\nОписание\n\nПроизводство Корея, новая\n\nGM\n\n96234567\n\nЦена\n\n450000',
    );
    expect(sameLine).toEqual(plain);
    expect(nextLine).toEqual(plain);
  });

  it('strips the label — stored values never contain the label text', () => {
    const r = parseStructuredCaption(
      'Название: Магнитола BOSCH\n\nОписание: новая\n\nGM: 96234567\n\nЦена: 450000',
    );
    expect(r?.title).toBe('Магнитола BOSCH');
    expect(r?.title).not.toMatch(/название/i);
    expect(r?.description).toBe('новая');
    expect(r?.description).not.toMatch(/описание/i);
  });

  it('accepts the "OEM" label as an alias for GM', () => {
    const r = parseStructuredCaption('Название: Фильтр\n\nOEM: 96535062');
    expect(r?.title).toBe('Фильтр');
    expect(r?.gm_number).toBe('96535062');
  });

  it('labels may end with an optional ":" (both accepted)', () => {
    const withColon = parseStructuredCaption('Название: Фильтр\n\nЦена: 1000');
    const noColon = parseStructuredCaption('Название\n\nФильтр\n\nЦена\n\n1000');
    expect(withColon?.title).toBe('Фильтр');
    expect(noColon?.title).toBe('Фильтр');
    expect(withColon?.price).toBe(1000);
    expect(noColon?.price).toBe(1000);
  });

  it('mixes inline and standalone labels in one caption', () => {
    const r = parseStructuredCaption(
      'Название: Магнитола\n\nОписание\n\nКорея новая\n\nЦена: 450000',
    );
    expect(r?.title).toBe('Магнитола');
    expect(r?.description).toBe('Корея новая');
    expect(r?.price).toBe(450000);
  });

  it('accepts a single labeled title paragraph', () => {
    const r = parseStructuredCaption('Название: Магнитола для Nexia 3');
    expect(r?.title).toBe('Магнитола для Nexia 3');
    expect(r?.brand).toBe('Chevrolet');
    expect(r?.models).toEqual(['Nexia 3']);
  });

  it('detects the vehicle from the label-free title', () => {
    const r = parseStructuredCaption('Название: Магнитола для Nexia 3\n\nЦена: 450000');
    expect(r?.brand).toBe('Chevrolet');
    expect(r?.models).toEqual(['Nexia 3']);
  });

  it('returns null (→ fallback) when a labeled caption has no title', () => {
    expect(
      parseStructuredCaption('Описание: что-то\n\nЦена: 450000'),
    ).toBeNull();
  });

  it('returns null (→ fallback) when a labeled GM value is invalid', () => {
    expect(
      parseStructuredCaption('Название: Магнитола\n\nGM: не номер'),
    ).toBeNull();
  });

  it('does not misread a positional caption whose later paragraph starts with a label word', () => {
    // First paragraph is NOT a label → positional parse; "Цена договорная" stays
    // as the description verbatim rather than being treated as a price label.
    const r = parseStructuredCaption(
      'Магнитола\n\nЦена договорная\n\n96234567\n\n450000',
    );
    expect(r?.title).toBe('Магнитола');
    expect(r?.description).toBe('Цена договорная');
    expect(r?.gm_number).toBe('96234567');
    expect(r?.price).toBe(450000);
  });
});

describe('parseStructuredCaption — official single-format equivalence', () => {
  const EXPECTED = {
    title: 'Магнитола для Nexia 3',
    description: 'Производство Корея, новая',
    brand: 'Chevrolet',
    models: ['Nexia 3'],
    gm_number: '96234567',
    price: 450000,
  };

  it('parses the OFFICIAL single-newline format', () => {
    const r = parseStructuredCaption(
      'Магнитола для Nexia 3\nПроизводство Корея, новая\n96234567\n450000',
    );
    expect(r).toEqual(EXPECTED);
  });

  it('parses the blank-line format identically', () => {
    const r = parseStructuredCaption(
      'Магнитола для Nexia 3\n\nПроизводство Корея, новая\n\n96234567\n\n450000',
    );
    expect(r).toEqual(EXPECTED);
  });

  it('single-newline and blank-line inputs produce identical results', () => {
    const single = parseStructuredCaption(
      'Магнитола для Nexia 3\nПроизводство Корея, новая\n96234567\n450000',
    );
    const blank = parseStructuredCaption(
      'Магнитола для Nexia 3\n\nПроизводство Корея, новая\n\n96234567\n\n450000',
    );
    expect(single).toEqual(blank);
  });

  it('ignores mixed empty lines between fields', () => {
    const r = parseStructuredCaption(
      'Магнитола для Nexia 3\n\nПроизводство Корея, новая\n96234567\n\n\n450000',
    );
    expect(r).toEqual(EXPECTED);
  });

  it('ignores trailing empty lines', () => {
    const r = parseStructuredCaption(
      'Магнитола для Nexia 3\nПроизводство Корея, новая\n96234567\n450000\n\n\n',
    );
    expect(r).toEqual(EXPECTED);
  });

  it('ignores leading empty lines (title is still the first NON-EMPTY line)', () => {
    const r = parseStructuredCaption(
      '\n\nМагнитола для Nexia 3\nПроизводство Корея, новая\n96234567\n450000',
    );
    expect(r?.title).toBe('Магнитола для Nexia 3');
    expect(r).toEqual(EXPECTED);
  });

  it('folds additional description lines (5+) in, keeping GM and price', () => {
    // 1=title, 2=desc, 3=GM, 4=price, then extra description lines.
    const r = parseStructuredCaption(
      'Тормозные колодки\nкомплект\n96535062\n120000\nхорошее состояние',
    );
    expect(r?.title).toBe('Тормозные колодки');
    expect(r?.description).toBe('комплект хорошее состояние');
    expect(r?.gm_number).toBe('96535062');
    expect(r?.price).toBe(120000);
  });

  it('title is always the first non-empty line, verbatim (whitespace-normalized)', () => {
    const r = parseStructuredCaption(
      '  Магнитола   BOSCH   для  Nexia 3  \nновая\n96234567\n450000',
    );
    expect(r?.title).toBe('Магнитола BOSCH для Nexia 3');
  });
});
