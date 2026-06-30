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

  it('keeps condition words out of the title', () => {
    const r = ruleBasedParse('ступица передняя spark matiz правая сторона');
    expect(r.title).toMatch(/ступица/i);
    expect(r.title?.toLowerCase()).not.toContain('правая сторона');
    expect(r.description?.toLowerCase()).toContain('правая сторона');
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
