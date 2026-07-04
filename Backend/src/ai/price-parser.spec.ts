// Tests for parsePrice — the shared price string → number utility.
//
// Covers the full required matrix, including the crux of the bug report:
//   "130.000" (thousands-grouped) → 130000, while "130.00" (decimal) → 130.

import { parsePrice } from './price-parser';

describe('parsePrice — thousands vs decimal separators', () => {
  // ── The required behavior matrix from the spec ────────────────────────────
  it.each([
    ['130.000', 130000], // dot as thousands separator
    ['1.250.000', 1250000], // multiple dot groups
    ['130 000', 130000], // space as thousands separator
    ['1 250 000', 1250000], // multiple space groups
    ['130,000', 130000], // comma as thousands separator
    ['130.00', 130], // decimal .00 → whole integer 130
    ['130.50', 130.5], // genuine decimal, trailing zero dropped
    ['99.99', 99.99], // genuine decimal preserved
  ])('parses %s → %s', (input, expected) => {
    expect(parsePrice(input)).toBe(expected);
  });

  // ── The specific regression the task calls out ────────────────────────────
  it('130.000 → 130000 (NOT 130)', () => {
    expect(parsePrice('130.000')).toBe(130000);
  });

  it('130.00 → 130 (still a decimal, not thousands)', () => {
    expect(parsePrice('130.00')).toBe(130);
  });
});

describe('parsePrice — currency stripping', () => {
  it.each([
    ['130.000 сум', 130000],
    ["130.000 so'm", 130000],
    ['130.000 UZS', 130000],
    ['130000 uzs', 130000],
    ['1.250.000 сўм', 1250000],
    ['99.99 usd', 99.99],
    ['$130000', 130000],
    ['130 000 у.е.', 130000],
  ])('parses %s → %s', (input, expected) => {
    expect(parsePrice(input)).toBe(expected);
  });
});

describe('parsePrice — plain and mixed', () => {
  it('plain integer', () => {
    expect(parsePrice('450000')).toBe(450000);
  });

  it('comma decimal (1250,50 → 1250.5)', () => {
    expect(parsePrice('1250,50')).toBe(1250.5);
  });

  it('single small number', () => {
    expect(parsePrice('5')).toBe(5);
  });

  it('mixed thousands + trimming', () => {
    expect(parsePrice('  1.250.000   ')).toBe(1250000);
  });
});

describe('parsePrice — rejects non-prices', () => {
  it.each([['', null], ['   ', null], ['сум', null], ['abc', null], ['0', null], ['-5', null]])(
    'parses %j → %s',
    (input, expected) => {
      expect(parsePrice(input as string)).toBe(expected);
    },
  );

  it('non-string input → null', () => {
    // @ts-expect-error runtime guard
    expect(parsePrice(undefined)).toBeNull();
    // @ts-expect-error runtime guard
    expect(parsePrice(12345)).toBeNull();
  });
});
