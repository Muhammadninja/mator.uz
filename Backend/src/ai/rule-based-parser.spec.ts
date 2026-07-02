import {
  RULE_CONFIDENCE_THRESHOLD,
  computeConfidence,
  normalizeText,
  ruleBasedParse,
} from './rule-based-parser';

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
