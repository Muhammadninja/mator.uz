// Tests for resolveDraftTtlMs: the draft lifetime (= resume window = sweep
// horizon) is read from DRAFT_TTL_HOURS, validated to an integer in [1, 168]
// hours, and falls back to the default (24h) with a warning on any invalid value.
//
// (Image-worker concurrency is resolved by resolveImageWorkerConcurrency in
// queue.constants.ts — the queue worker is the only image pipeline — and is
// covered by queue.service.spec.ts.)

import { Logger } from '@nestjs/common';
import { resolveDraftTtlMs } from './telegram.service';

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
