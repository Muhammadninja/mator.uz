import { normalizeOem } from './normalize-oem.util';

describe('normalizeOem', () => {
  it('strips spaces, dashes, dots, slashes and uppercases', () => {
    expect(normalizeOem(' sp- 1362. ')).toBe('SP1362');
    expect(normalizeOem('96.943.770')).toBe('96943770');
    expect(normalizeOem('95231012')).toBe('95231012');
    expect(normalizeOem('gm/25183779')).toBe('GM25183779');
  });

  it('is idempotent (already-normalized input is unchanged)', () => {
    expect(normalizeOem('SP1362')).toBe('SP1362');
    expect(normalizeOem(normalizeOem(' sp-1362 '))).toBe('SP1362');
  });

  it('is safe on empty / null / undefined', () => {
    expect(normalizeOem('')).toBe('');
    expect(normalizeOem(null)).toBe('');
    expect(normalizeOem(undefined)).toBe('');
    expect(normalizeOem('  --  ')).toBe('');
  });

  it('drops non-latin characters', () => {
    expect(normalizeOem('арт-95231012')).toBe('95231012');
  });
});
