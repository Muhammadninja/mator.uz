import { normalizeSourcePrice, parseDecimal } from './drivers-village-price';

const ok = (raw: string) => {
  const r = normalizeSourcePrice(raw);
  if (!r.ok) throw new Error(`"${raw}" was rejected: ${r.reason}`);
  return r;
};
const reason = (raw: string) => {
  const r = normalizeSourcePrice(raw);
  if (r.ok) throw new Error(`"${raw}" was accepted as ${r.priceUzs}`);
  return r.reason;
};

describe('normalizeSourcePrice — the 1C price rule', () => {
  it.each([
    // Below 1000: thousands of UZS, ×1000.
    ['690', '690000.00', true],
    ['60', '60000.00', true],
    ['6', '6000.00', true],
    ['6,5', '6500.00', true],
    ['68,7', '68700.00', true],
    ['320,65', '320650.00', true],
    ['530,560', '530560.00', true],
    ['999,999', '999999.00', true],
    // From 1000 up: UZS as given.
    ['1000', '1000.00', false],
    ['12500', '12500.00', false],
  ])('%s → %s', (raw, priceUzs, scaled) => {
    expect(ok(raw)).toEqual({ ok: true, priceUzs, scaled });
  });

  it('reads the export’s other spellings of the same numbers', () => {
    expect(ok(' 6.5 ').priceUzs).toBe('6500.00'); // dot decimal, padding
    expect(ok('12 500').priceUzs).toBe('12500.00'); // space grouping
    expect(ok('12\u00a0500,00').priceUzs).toBe('12500.00'); // NBSP grouping
    expect(ok('490 000,00').priceUzs).toBe('490000.00');
    expect(ok('195 642,86').priceUzs).toBe('195642.86');
    expect(ok('999,99999').priceUzs).toBe('999999.99'); // 5 decimals still fit
    expect(ok('999,9995')).toEqual({
      ok: true,
      priceUzs: '999999.50',
      scaled: true,
    });
  });

  it('the boundary: 999,999… is thousands, 1000 and 1000,00 are UZS', () => {
    expect(ok('999,99').scaled).toBe(true);
    expect(ok('1000,00')).toEqual({
      ok: true,
      priceUzs: '1000.00',
      scaled: false,
    });
    expect(ok('1 000').scaled).toBe(false);
  });

  it('is a pure function of the cell: the same cell always gives the same price', () => {
    for (const raw of ['320,65', '690', '12500'])
      expect(normalizeSourcePrice(raw)).toEqual(normalizeSourcePrice(raw));
    // A price that is already in UZS (≥1000) is never scaled again.
    expect(ok(ok('320,65').priceUzs).priceUzs).toBe('320650.00');
  });

  it('never rounds: too many decimals for the scale are rejected', () => {
    // UZS (≥1000): at most 2 decimals.
    expect(reason('195 642,855')).toMatch(/more than 2 decimal places/);
    expect(reason('1000,001')).toMatch(/never rounded/);
    // Thousands (<1000): at most 5, which land on whole tiyin after ×1000.
    expect(reason('999,999999')).toMatch(/in thousands of UZS/);
    expect(reason('1,000000000000000000001')).toMatch(/in thousands/);
  });

  it('rejects empty, zero, negative, malformed and oversize values with a reason', () => {
    expect(reason('')).toBe('empty');
    expect(reason('   ')).toBe('empty');
    expect(reason('0')).toBe('must be greater than 0');
    expect(reason('0,000')).toBe('must be greater than 0');
    expect(reason('-55,200')).toBe('negative');
    expect(reason('-6')).toBe('negative');
    // Two separators: a decimal comma and a thousands comma read differently.
    expect(reason('1,600,000')).toBe('more than one decimal separator');
    expect(reason('1.234,56')).toBe('more than one decimal separator');
    for (const raw of ['abc', '1e5', '12,5 сум', '#ДЕЛ/0!', '+5'])
      expect(reason(raw)).toBe('not a plain non-negative number');
    expect(reason('1 000 000 000 000')).toMatch(/exceeds/);
  });
});

describe('parseDecimal', () => {
  it('caps the fraction only when asked to', () => {
    expect(parseDecimal('2,345', 2)).toEqual({
      ok: false,
      reason: 'more than 2 decimal places',
    });
    const r = parseDecimal('2,345');
    expect(r.ok && r.value.toString()).toBe('2.345');
  });
});
