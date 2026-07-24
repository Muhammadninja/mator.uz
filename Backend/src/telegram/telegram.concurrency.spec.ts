// Tests for resolveImageConcurrency: the album image-processing concurrency is
// read from IMAGE_CONCURRENCY, validated to an integer in [1, 10], and falls
// back to the default (5) with a warning on any invalid value.

import { Logger } from '@nestjs/common';
import { resolveImageConcurrency, resolveDraftTtlMs } from './telegram.service';

const DEFAULT = 5;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_TTL_MS = 24 * HOUR_MS;

// A logger stub that records warnings so we can assert on the fallback path.
function makeLogger() {
  const warnings: string[] = [];
  const logger = {
    warn: (msg: string) => warnings.push(msg),
  } as unknown as Logger;
  return { logger, warnings };
}

describe('resolveImageConcurrency', () => {
  it('uses the default when unset', () => {
    const { logger, warnings } = makeLogger();
    expect(resolveImageConcurrency(undefined, logger)).toBe(DEFAULT);
    expect(warnings).toEqual([]); // unset is expected — no warning
  });

  it('uses the default for an empty/whitespace value without warning', () => {
    const { logger, warnings } = makeLogger();
    expect(resolveImageConcurrency('   ', logger)).toBe(DEFAULT);
    expect(warnings).toEqual([]);
  });

  it('accepts a valid integer within range', () => {
    const { logger, warnings } = makeLogger();
    expect(resolveImageConcurrency('5', logger)).toBe(5);
    expect(resolveImageConcurrency('1', logger)).toBe(1); // min
    expect(resolveImageConcurrency('10', logger)).toBe(10); // max
    expect(warnings).toEqual([]);
  });

  it('falls back and warns when below the minimum', () => {
    const { logger, warnings } = makeLogger();
    expect(resolveImageConcurrency('0', logger)).toBe(DEFAULT);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('IMAGE_CONCURRENCY');
  });

  it('falls back and warns when above the maximum', () => {
    const { logger, warnings } = makeLogger();
    expect(resolveImageConcurrency('11', logger)).toBe(DEFAULT);
    expect(warnings).toHaveLength(1);
  });

  it('falls back and warns for a non-integer value', () => {
    const { logger, warnings } = makeLogger();
    expect(resolveImageConcurrency('3.5', logger)).toBe(DEFAULT);
    expect(warnings).toHaveLength(1);
  });

  it('falls back and warns for a non-numeric value', () => {
    const { logger, warnings } = makeLogger();
    expect(resolveImageConcurrency('abc', logger)).toBe(DEFAULT);
    expect(warnings).toHaveLength(1);
  });

  it('falls back and warns for a negative value', () => {
    const { logger, warnings } = makeLogger();
    expect(resolveImageConcurrency('-3', logger)).toBe(DEFAULT);
    expect(warnings).toHaveLength(1);
  });
});

describe('resolveDraftTtlMs', () => {
  it('uses the default (24h) when unset/blank, without warning', () => {
    const { logger, warnings } = makeLogger();
    expect(resolveDraftTtlMs(undefined, logger)).toBe(DEFAULT_TTL_MS);
    expect(resolveDraftTtlMs('  ', logger)).toBe(DEFAULT_TTL_MS);
    expect(warnings).toEqual([]);
  });

  it('accepts a valid integer hour count within [1, 168]', () => {
    const { logger, warnings } = makeLogger();
    expect(resolveDraftTtlMs('1', logger)).toBe(1 * HOUR_MS); // min
    expect(resolveDraftTtlMs('48', logger)).toBe(48 * HOUR_MS);
    expect(resolveDraftTtlMs('168', logger)).toBe(168 * HOUR_MS); // max (7d)
    expect(warnings).toEqual([]);
  });

  it('falls back and warns for out-of-range / non-integer / non-numeric values', () => {
    const { logger, warnings } = makeLogger();
    expect(resolveDraftTtlMs('0', logger)).toBe(DEFAULT_TTL_MS); // below min
    expect(resolveDraftTtlMs('169', logger)).toBe(DEFAULT_TTL_MS); // above max
    expect(resolveDraftTtlMs('2.5', logger)).toBe(DEFAULT_TTL_MS); // non-integer
    expect(resolveDraftTtlMs('abc', logger)).toBe(DEFAULT_TTL_MS); // non-numeric
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toContain('DRAFT_TTL_HOURS');
  });
});
