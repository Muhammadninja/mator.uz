import { parseOfferPrice } from './sourcing-offer-parse.util';

describe('parseOfferPrice', () => {
  it('parses a plain number', () => {
    expect(parseOfferPrice('250000')).toBe(250000);
  });

  it('ignores spaces / dots / commas as thousands separators', () => {
    expect(parseOfferPrice('250 000')).toBe(250000);
    expect(parseOfferPrice('250.000')).toBe(250000);
    expect(parseOfferPrice('1,250,000')).toBe(1250000);
  });

  it('extracts the number from surrounding words', () => {
    expect(parseOfferPrice('цена 250000 сум')).toBe(250000);
    expect(parseOfferPrice('primerno 300000')).toBe(300000);
  });

  it('honours к / k / тыс (×1000) and млн / mln (×1_000_000)', () => {
    expect(parseOfferPrice('250к')).toBe(250000);
    expect(parseOfferPrice('250k')).toBe(250000);
    expect(parseOfferPrice('300тыс')).toBe(300000);
    expect(parseOfferPrice('1.2млн')).toBe(1200000);
    expect(parseOfferPrice('1,2 mln')).toBe(1200000);
  });

  it('rejects empty / non-numeric / out-of-range input', () => {
    expect(parseOfferPrice('')).toBeNull();
    expect(parseOfferPrice('сколько стоит?')).toBeNull();
    expect(parseOfferPrice('50')).toBeNull(); // below MIN_PRICE
    expect(parseOfferPrice('99999999999')).toBeNull(); // above MAX_PRICE
  });
});
