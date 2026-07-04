// Tests for validateMetadataShape — specifically that the AI price path uses the
// SAME shared parsePrice as every other path, so "130.000" → 130000 even when it
// comes back from the model.

import { validateMetadataShape } from './claude-mcp.service';

const base = {
  title: 'Фильтр Cobalt',
  description: null,
  brand: 'Chevrolet',
  models: ['Cobalt'],
  gm_number: null,
};

describe('validateMetadataShape — price_raw via shared parsePrice', () => {
  it.each([
    ['130.000', 130000], // dot as thousands — the reported bug
    ['1.250.000', 1250000],
    ['130 000', 130000],
    ['130,000', 130000],
    ['130.00', 130],
    ['130.50', 130.5],
    ['25000', 25000],
  ])('price_raw "%s" → %s', (priceRaw, expected) => {
    const out = validateMetadataShape({ ...base, price_raw: priceRaw });
    expect(out.price).toBe(expected);
  });

  it('price_raw null → price null', () => {
    expect(validateMetadataShape({ ...base, price_raw: null }).price).toBeNull();
  });

  it('unparseable price_raw → null (not a throw)', () => {
    expect(validateMetadataShape({ ...base, price_raw: 'договорная' }).price).toBeNull();
  });
});

describe('validateMetadataShape — backward compatibility with numeric price', () => {
  it('accepts a numeric price field (legacy shape)', () => {
    expect(validateMetadataShape({ ...base, price: 25000 }).price).toBe(25000);
  });

  it('numeric price null → null', () => {
    expect(validateMetadataShape({ ...base, price: null }).price).toBeNull();
  });

  it('missing both price and price_raw → null', () => {
    expect(validateMetadataShape({ ...base }).price).toBeNull();
  });
});
