import {
  RULE_CONFIDENCE_THRESHOLD,
  computeConfidence,
  extractPriceFromText,
  normalizeText,
  ruleBasedParse,
} from './rule-based-parser';

describe('extractPriceFromText — the shared text→price entry point', () => {
  // This is what the Telegram price fallback (extractPriceFallback) now uses, so
  // these guard the production fallback path against the old "130.000 → 130/0" bug.
  it.each([
    ['130.000 сум', 130000],
    ['1.250.000 сум', 1250000],
    ["130.000 so'm", 130000],
    ['350000 сум', 350000],
    ['130.00 сум', 130],
    ['Фильтр масла 96535062 25000 сум', 25000], // skips the GM code, takes the price
  ])('extracts %s → %s', (input, expected) => {
    expect(extractPriceFromText(input)).toBe(expected);
  });

  it('returns null when there is no price', () => {
    expect(extractPriceFromText('нет цены тут')).toBeNull();
  });

  it('ignores a bare phone number (not a price)', () => {
    expect(extractPriceFromText('звоните 998901234567')).toBeNull();
  });
});

describe('normalizeText', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeText('  Фильтр   масла \n Cobalt ')).toBe('Фильтр масла Cobalt');
  });
});

describe('ruleBasedParse', () => {
  it('parses a complete listing with high confidence', () => {
    const r = ruleBasedParse('Фильтр масла Cobalt оригинал 96535062 25000 сум');
    expect(r.brand).toBe('Chevrolet');
    expect(r.models).toEqual(['Cobalt']);
    expect(r.gm_number).toBe('96535062');
    expect(r.price).toBe(25000);
    expect(r.title).toMatch(/фильтр/i);
    expect(r.confidence).toBeGreaterThanOrEqual(RULE_CONFIDENCE_THRESHOLD);
  });

  it('detects multiple models and the shared brand', () => {
    const r = ruleBasedParse('колодки тормозные cobalt gentra lacetti 25000 сум');
    expect(r.brand).toBe('Chevrolet');
    expect(r.models).toEqual(expect.arrayContaining(['Cobalt', 'Gentra', 'Lacetti']));
    expect(r.price).toBe(25000);
  });

  it('extracts gm_number distinct from price', () => {
    const r = ruleBasedParse('Тормозной диск Nexia 3 97168181 100000 uzs');
    expect(r.gm_number).toBe('97168181');
    expect(r.price).toBe(100000);
    expect(r.models).toContain('Nexia 3');
  });

  it('detects condition words into the description but keeps them in the title', () => {
    // INVARIANT: single-line title is the whole seller line, verbatim. Condition
    // words are DETECTED into the description but NOT removed from the title.
    const r = ruleBasedParse('ступица передняя spark matiz правая сторона');
    expect(r.title).toBe('ступица передняя spark matiz правая сторона'); // verbatim
    expect(r.title?.toLowerCase()).toContain('правая сторона'); // stays in title
    expect(r.description?.toLowerCase()).toContain('правая сторона'); // also detected
    expect(r.models).toEqual(expect.arrayContaining(['Spark', 'Matiz']));
  });

  it('resolves cyrillic and typo aliases', () => {
    const r = ruleBasedParse('генератор кобальт 150000 сум');
    expect(r.brand).toBe('Chevrolet');
    expect(r.models).toEqual(['Cobalt']);
  });

  it('returns low confidence and null fields for junk text', () => {
    const r = ruleBasedParse('HShshdh (HShha)');
    expect(r.brand).toBeNull();
    expect(r.models).toEqual([]);
    expect(r.gm_number).toBeNull();
    expect(r.price).toBeNull();
    expect(r.confidence).toBeLessThan(RULE_CONFIDENCE_THRESHOLD);
  });

  it('gives a bare part name low-to-medium confidence (needs AI)', () => {
    const r = ruleBasedParse('генератор');
    expect(r.title).toMatch(/генератор/i);
    // Only the title signal — below threshold, so AI fallback kicks in.
    expect(r.confidence).toBeLessThan(RULE_CONFIDENCE_THRESHOLD);
  });
});

describe('ruleBasedParse — multi-paragraph hardening', () => {
  it('never merges a later paragraph into the title (the "Магнитола для Производство Корея" bug)', () => {
    const r = ruleBasedParse('Магнитола для Nexia 3\n\nПроизводство Корея, новая');
    // The title is the verbatim first paragraph — NOT flattened, NOT merged.
    expect(r.title).toBe('Магнитола для Nexia 3');
    expect(r.title).not.toContain('Производство');
    // Regression guard for the exact corrupt value that was observed.
    expect(r.title).not.toBe('Магнитола для Производство Корея');
  });

  it('keeps the detected make/model IN the title (does not strip it)', () => {
    const r = ruleBasedParse('Магнитола для Nexia 3\n\nПроизводство Корея, новая');
    expect(r.title).toContain('Nexia 3'); // model NOT removed from the title
    expect(r.brand).toBe('Chevrolet'); // ...but still detected into the field
    expect(r.models).toEqual(['Nexia 3']);
    expect(r.preserveTitle).toBe(true);
  });

  it('uses only the first paragraph for the title and the rest for description', () => {
    const r = ruleBasedParse('Магнитола для Nexia 3\n\nПроизводство Корея, новая');
    expect(r.title).toBe('Магнитола для Nexia 3');
    expect(r.description).toBe('Производство Корея, новая');
  });

  it('detects GM/OEM and price from the later paragraphs, keeping the title clean', () => {
    const r = ruleBasedParse('Тормозные колодки\n\nкомплект\n\n96535062\n\n120000');
    expect(r.title).toBe('Тормозные колодки');
    expect(r.gm_number).toBe('96535062');
    expect(r.price).toBe(120000);
    // Neither the OEM nor the price leaked into the title.
    expect(r.title).not.toMatch(/\d/);
  });

  it('normalizes whitespace in the first-paragraph title without rewriting it', () => {
    const r = ruleBasedParse('Магнитола   BOSCH   для  Nexia 3\n\nновая');
    expect(r.title).toBe('Магнитола BOSCH для Nexia 3'); // collapsed spaces, words intact
  });

  it('single-paragraph title is the whole seller line, verbatim (invariant)', () => {
    const r = ruleBasedParse('Фильтр масла Cobalt оригинал 96535062 25000 сум');
    // INVARIANT: nothing is stripped from the title — model/OEM/price stay in.
    expect(r.title).toBe('Фильтр масла Cobalt оригинал 96535062 25000 сум');
    expect(r.title).toContain('Cobalt'); // model NOT removed
    expect(r.title).toContain('96535062'); // OEM NOT removed
    // ...but the fields are still detected independently.
    expect(r.brand).toBe('Chevrolet');
    expect(r.models).toEqual(['Cobalt']);
    expect(r.gm_number).toBe('96535062');
    expect(r.price).toBe(25000);
    expect(r.preserveTitle).toBe(true);
  });
});

describe('ruleBasedParse — title→description recovery (two-line listings)', () => {
  it('recovers price from the description when the title has none', () => {
    // Title has brand+model+part name but NO price; description supplies it.
    const r = ruleBasedParse('Фара передняя Cobalt\n\nоригинал 350000 сум');
    expect(r.title).toBe('Фара передняя Cobalt'); // title untouched
    expect(r.models).toContain('Cobalt'); // from the title
    expect(r.price).toBe(350000); // recovered from the description
  });

  it('parses 130.000 from the description as 130000 (thousands, not 130)', () => {
    // Regression guard for the reported bug: a dot-grouped price in the
    // description must use the shared parser (130.000 → 130000), with or
    // without a currency word.
    expect(ruleBasedParse('Фара Cobalt\n\nоригинал 130.000 сум').price).toBe(130000);
    expect(ruleBasedParse('Фара Cobalt\n\nоригинал 130.000').price).toBe(130000);
    expect(ruleBasedParse('Фара Cobalt\n\nцена 1.250.000 сум').price).toBe(1250000);
  });

  it('recovers an 11-digit GM number from the description', () => {
    const r = ruleBasedParse('Фара передняя Cobalt\n\nоригинал 96549774112 350000 сум');
    expect(r.gm_number).toBe('96549774112'); // exactly 11 digits, from description
    expect(r.price).toBe(350000);
  });

  it('recovers brand/model from the description when the title lacks them', () => {
    const r = ruleBasedParse('Магнитола\n\nChevrolet Cobalt новая 200000 сум');
    expect(r.title).toBe('Магнитола');
    expect(r.brand).toBe('Chevrolet'); // recovered from description
    expect(r.models).toContain('Cobalt');
    expect(r.price).toBe(200000);
  });

  it('make/model fallback uses line 2 only — a vehicle on line 3 is NOT used', () => {
    // Title has no vehicle; line 2 (description) has none either; a model name
    // sits on line 3 alongside the GM. It must NOT populate make/model, since the
    // fallback only ever looks at line 2.
    const r = ruleBasedParse('Магнитола\n\nоригинал новая\n\nCobalt 96549774112\n\n350000');
    expect(r.brand).toBeNull();
    expect(r.models).toEqual([]);
  });

  it('PREFERS title values over description values (title wins)', () => {
    // Both lines carry a price; the title's must win (rule #3).
    const r = ruleBasedParse('Диск тормозной 100000 сум\n\nбыло 999999 сум');
    expect(r.price).toBe(100000); // title price, NOT the description's 999999
  });

  it('UNIONS title and description models (description no longer ignored)', () => {
    const r = ruleBasedParse('Бампер Spark\n\nподходит на Cobalt тоже');
    // Both lines contribute: the title model stays AND the description adds.
    expect(r.models).toEqual(expect.arrayContaining(['Spark', 'Cobalt']));
    expect(r.vehicles).toEqual(
      expect.arrayContaining([
        { brand: 'Chevrolet', model: 'Spark' },
        { brand: 'Chevrolet', model: 'Cobalt' },
      ]),
    );
  });

  it('prefers an 11-digit GM number over a shorter number in the description', () => {
    const r = ruleBasedParse('Фара Cobalt\n\n96549774112 250000 сум');
    expect(r.gm_number).toBe('96549774112'); // full 11-digit code preferred
    expect(r.price).toBe(250000);
  });

  it('accepts an 8-digit GM number from the description (real GM length)', () => {
    // Per the agreed rule: description GM = 8–11 digits, preferring 11.
    const r = ruleBasedParse('Фильтр Cobalt\n\n96535062 50000 сум');
    expect(r.gm_number).toBe('96535062'); // 8-digit GM accepted
    expect(r.price).toBe(50000);
  });

  it('rejects a too-short (5-digit) article number as a GM on the desc path', () => {
    const r = ruleBasedParse('Фара Cobalt\n\nартикул 12345, цена 40000 сум');
    expect(r.gm_number).toBeNull(); // 5 digits < 8, not a GM number
    expect(r.price).toBe(40000);
  });
});

describe('extractPrice — currency variants and unrelated numbers', () => {
  it.each([
    ["so'm", 'Фара 350000 so\'m'],
    ['soʻm', 'Фара 350000 soʻm'],
    ['сўм', 'Фара 350000 сўм'],
    ['сoʻм', 'Фара 350000 сoʻм'],
    ['сом', 'Фара 350000 сом'],
    ['som', 'Фара 350000 som'],
    ['UZS', 'Фара 350000 UZS'],
  ])('parses price with currency "%s"', (_label, text) => {
    const r = ruleBasedParse(text);
    expect(r.price).toBe(350000);
  });

  it('ignores a phone number as a price', () => {
    const r = ruleBasedParse('Фара Cobalt\n\nтел +998901234567 звоните');
    expect(r.price).toBeNull(); // phone is not a price
  });

  it('ignores a year as a price', () => {
    const r = ruleBasedParse('Фара Cobalt\n\nмашина 2015 года');
    expect(r.price).toBeNull(); // 2015 is a year, not a price
  });

  it('ignores mileage as a price', () => {
    const r = ruleBasedParse('Двигатель Cobalt\n\nпробег 120000 км');
    expect(r.price).toBeNull(); // 120000 km is mileage, not a price
  });

  it('still takes a currency-marked price even when a year is present', () => {
    const r = ruleBasedParse('Фара Cobalt\n\n2015 года, цена 250000 сум');
    expect(r.price).toBe(250000);
  });
});

describe('computeConfidence', () => {
  it('sums the configured weights', () => {
    expect(
      computeConfidence({
        hasGm: true,
        hasPrice: true,
        hasBrandOrModel: true,
        hasGoodTitle: true,
      }),
    ).toBe(1);
  });

  it('gm + price sums to 0.60 (just below threshold without a title/brand)', () => {
    const score = computeConfidence({
      hasGm: true,
      hasPrice: true,
      hasBrandOrModel: false,
      hasGoodTitle: false,
    });
    expect(score).toBeCloseTo(0.6, 5);
    expect(score).toBeLessThan(RULE_CONFIDENCE_THRESHOLD);
  });

  it('gm + price + a good title clears the threshold', () => {
    const score = computeConfidence({
      hasGm: true,
      hasPrice: true,
      hasBrandOrModel: false,
      hasGoodTitle: true,
    });
    expect(score).toBeGreaterThanOrEqual(RULE_CONFIDENCE_THRESHOLD);
  });

  it('a lone good title is below the threshold', () => {
    const score = computeConfidence({
      hasGm: false,
      hasPrice: false,
      hasBrandOrModel: false,
      hasGoodTitle: true,
    });
    expect(score).toBeLessThan(RULE_CONFIDENCE_THRESHOLD);
  });
});

// ── Vehicle compatibility: SINGLE / MULTIPLE / UNIVERSAL (rule-based path) ────
describe('ruleBasedParse — vehicle compatibility', () => {
  it('single vehicle → one (brand, model) pair', () => {
    const r = ruleBasedParse('Фара передняя Cobalt 96549774 350000 сум');
    expect(r.isUniversal).toBe(false);
    expect(r.vehicles).toEqual([{ brand: 'Chevrolet', model: 'Cobalt' }]);
  });

  it('multiple vehicles in the TITLE → all pairs extracted', () => {
    const r = ruleBasedParse('Колодки Cobalt / Gentra 96549774 150000 сум');
    expect(r.vehicles).toEqual(
      expect.arrayContaining([
        { brand: 'Chevrolet', model: 'Cobalt' },
        { brand: 'Chevrolet', model: 'Gentra' },
      ]),
    );
  });

  it('multiple vehicles in the DESCRIPTION → all pairs extracted', () => {
    const r = ruleBasedParse('Свеча зажигания\n\nДля Cobalt, Gentra и Lacetti 50000 сум');
    expect(r.models).toEqual(expect.arrayContaining(['Cobalt', 'Gentra', 'Lacetti']));
    expect(r.vehicles).toHaveLength(3);
  });

  it('title+description vehicles merge into one deduplicated set', () => {
    const r = ruleBasedParse('Бампер Cobalt\n\nПодходит также Gentra и Lacetti, и на Cobalt');
    expect(r.vehicles).toHaveLength(3); // Cobalt deduplicated across lines
    expect(r.vehicles).toEqual(
      expect.arrayContaining([
        { brand: 'Chevrolet', model: 'Cobalt' },
        { brand: 'Chevrolet', model: 'Gentra' },
        { brand: 'Chevrolet', model: 'Lacetti' },
      ]),
    );
  });

  it('cross-brand listing keeps every model under its own brand', () => {
    const r = ruleBasedParse('Стойка стабилизатора Cobalt, Solaris 90000 сум');
    expect(r.vehicles).toEqual(
      expect.arrayContaining([
        { brand: 'Chevrolet', model: 'Cobalt' },
        { brand: 'Hyundai', model: 'Solaris' },
      ]),
    );
  });

  it('UNIVERSAL claim → isUniversal, no vehicles, no models', () => {
    const r = ruleBasedParse('Коврики универсальные 96535062 120000 сум');
    expect(r.isUniversal).toBe(true);
    expect(r.vehicles).toEqual([]);
    expect(r.models).toEqual([]);
    expect(r.brand).toBeNull();
    // GM/price extraction is unaffected by the universal claim.
    expect(r.gm_number).toBe('96535062');
    expect(r.price).toBe(120000);
  });

  it('UNIVERSAL claim in the description wins over a model in the title', () => {
    const r = ruleBasedParse('Ароматизатор Cobalt\n\nПодходит ко всем автомобилям 20000 сум');
    expect(r.isUniversal).toBe(true);
    expect(r.vehicles).toEqual([]);
  });

  it('GM and price extraction behave exactly as before on multi-vehicle text', () => {
    const r = ruleBasedParse('Фильтр масла Cobalt Gentra оригинал 96535062 25000 сум');
    expect(r.gm_number).toBe('96535062');
    expect(r.price).toBe(25000);
    expect(r.models).toEqual(expect.arrayContaining(['Cobalt', 'Gentra']));
  });
});
