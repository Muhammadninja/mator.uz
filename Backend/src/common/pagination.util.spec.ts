import { clampLimit, clampRadius } from './pagination.util';

describe('clampLimit', () => {
  it('returns the fallback for undefined/null/NaN', () => {
    expect(clampLimit(undefined, 20, 100)).toBe(20);
    expect(clampLimit(null, 20, 100)).toBe(20);
    expect(clampLimit(Number.NaN, 20, 100)).toBe(20);
  });

  it('passes through in-range values (floored)', () => {
    expect(clampLimit(5, 20, 100)).toBe(5);
    expect(clampLimit(50.9, 20, 100)).toBe(50);
  });

  it('caps at max', () => {
    expect(clampLimit(1_000_000, 20, 100)).toBe(100);
    expect(clampLimit(101, 20, 100)).toBe(100);
  });

  it('floors below-1 values to 1', () => {
    expect(clampLimit(0, 20, 100)).toBe(1);
    expect(clampLimit(-5, 20, 100)).toBe(1);
  });
});

describe('clampRadius', () => {
  it('returns the fallback for undefined/null/NaN', () => {
    expect(clampRadius(undefined, 5000, 50000)).toBe(5000);
    expect(clampRadius(Number.POSITIVE_INFINITY, 5000, 50000)).toBe(5000);
  });

  it('caps at max and floors below 1', () => {
    expect(clampRadius(9_999_999, 5000, 50000)).toBe(50000);
    expect(clampRadius(0, 5000, 50000)).toBe(1);
    expect(clampRadius(12000, 5000, 50000)).toBe(12000);
  });
});
