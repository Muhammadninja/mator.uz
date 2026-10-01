// The explicit business TOP-300 list: validation + ordering (pure, no DB).

import { FITMENT_TOP300_PART_IDS } from './fitment-top300.list';
import {
  TOP300_TARGET_SIZE,
  sortByTop300,
  top300Positions,
  validateTop300List,
} from './top300-list';

describe('validateTop300List', () => {
  it('keeps the explicit order as written', () => {
    const r = validateTop300List(['part_c', 'part_a', 'part_b']);
    expect(r.ids).toEqual(['part_c', 'part_a', 'part_b']);
    expect(r.entries.map((e) => e.position)).toEqual([1, 2, 3]);
  });

  it('detects a duplicate and keeps the FIRST occurrence', () => {
    const r = validateTop300List(['part_a', 'part_b', 'part_a']);
    expect(r.ids).toEqual(['part_a', 'part_b']);
    expect(r.duplicates).toEqual([
      {
        position: 3,
        identifier: 'part_a',
        status: 'duplicate',
        firstPosition: 1,
      },
    ]);
  });

  it('flags malformed identifiers as invalid', () => {
    const r = validateTop300List([
      'part_ok',
      '',
      ' part_space',
      'x'.repeat(65),
      42,
    ]);
    expect(r.ids).toEqual(['part_ok']);
    expect(r.invalid.map((e) => e.position)).toEqual([2, 3, 4, 5]);
  });

  it('diagnoses ids unknown to the supplied catalogue (resolved / unknown)', () => {
    const r = validateTop300List(
      ['part_a', 'part_ghost'],
      new Set(['part_a', 'part_z']),
    );
    expect(r.entries.map((e) => e.status)).toEqual(['resolved', 'unknown']);
    expect(r.unknown.map((e) => e.identifier)).toEqual(['part_ghost']);
  });

  it('reports valid ids as unchecked when no catalogue is supplied', () => {
    const r = validateTop300List(['part_a']);
    expect(r.entries[0].status).toBe('unchecked');
    expect(r.unknown).toEqual([]);
  });

  it('a list shorter than 300 is valid, incomplete, and NOT padded', () => {
    const r = validateTop300List(['part_a', 'part_b']);
    expect(r.ids).toHaveLength(2);
    expect(r.isComplete).toBe(false);
    expect(r.targetSize).toBe(TOP300_TARGET_SIZE);
  });

  it('a list of exactly 300 unique ids is complete', () => {
    const ids = Array.from({ length: 300 }, (_, i) => `part_stock_${i + 1}`);
    expect(validateTop300List(ids).isComplete).toBe(true);
  });
});

describe('sortByTop300', () => {
  it('orders rows by list position whatever order they arrive in', () => {
    const pos = top300Positions(['part_c', 'part_a', 'part_b']);
    const rows = [{ id: 'part_a' }, { id: 'part_b' }, { id: 'part_c' }];
    expect(sortByTop300(rows, pos).map((r) => r.id)).toEqual([
      'part_c',
      'part_a',
      'part_b',
    ]);
  });
});

describe('the SHIPPED list (fitment-top300.list.ts)', () => {
  // CI gate: the committed list may be incomplete, but never malformed.
  const report = validateTop300List(FITMENT_TOP300_PART_IDS);

  it('has no duplicate identifiers', () => {
    expect(report.duplicates).toEqual([]);
  });

  it('has no malformed identifiers', () => {
    expect(report.invalid).toEqual([]);
  });

  it('is not longer than the target size', () => {
    expect(report.ids.length).toBeLessThanOrEqual(TOP300_TARGET_SIZE);
  });
});
