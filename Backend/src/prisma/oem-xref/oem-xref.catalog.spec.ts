import { part } from '../../../test/utils/oem-xref-fixture';
import {
  findGmNumberCandidates,
  listedNumbers,
  parseCatalogSnapshot,
  XrefSnapshotFormatError,
} from './oem-xref.catalog';

const snapshotJson = (parts: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: 'oem-xref-catalog',
    format_version: 1,
    captured_at: '2026-11-13T08:00:00Z',
    database: 'fixture',
    parts,
    ...extra,
  });

const row = (id: string, gm: unknown[], oem: unknown[] = []) => ({
  id,
  title: id,
  part_brand_name: null,
  part_number_type: 'GM',
  gm_numbers: gm,
  oem_numbers: oem,
});

describe('OEM cross-reference catalog snapshot', () => {
  it('parses the SQL output and keeps numbers as strings', () => {
    const s = parseCatalogSnapshot(snapshotJson([row('p1', ['09600001'])]));
    expect(s.parts[0].gmNumbers).toEqual(['09600001']);
    expect(s.capturedAt).toBe('2026-11-13T08:00:00Z');
  });

  it('refuses a number sent as a JSON number (it would lose its leading zero)', () => {
    expect(() =>
      parseCatalogSnapshot(snapshotJson([row('p1', [9600001])])),
    ).toThrow(/leading zeros/);
  });

  it('refuses another kind of snapshot (e.g. the vehicle-reference one)', () => {
    expect(() =>
      parseCatalogSnapshot(
        JSON.stringify({ captured_at: 'x', makes: [], models: [] }),
      ),
    ).toThrow(XrefSnapshotFormatError);
    expect(() =>
      parseCatalogSnapshot(snapshotJson([], { format_version: 2 })),
    ).toThrow(/format_version/);
  });

  it('refuses a part listed twice', () => {
    expect(() =>
      parseCatalogSnapshot(snapshotJson([row('p1', []), row('p1', [])])),
    ).toThrow(/twice/);
  });
});

describe('number labels', () => {
  it('reads GM-only, OEM-only and both-arrays (unlabelled) numbers, keeping the stored spelling', () => {
    const listed = listedNumbers(
      part('p', {
        gm: ['96.000.001', '96000001', '96000003'],
        oem: ['ACME-7', 'ACME7', '96000003'],
      }),
    );
    expect(listed.get('96000001')).toEqual({
      canonical: '96000001',
      label: 'GM',
      asStored: ['96.000.001'],
    });
    expect(listed.get('ACME7')).toEqual({
      canonical: 'ACME7',
      label: 'OEM',
      asStored: ['ACME-7'],
    });
    expect(listed.get('96000003')?.label).toBe('UNLABELLED');
  });
});

describe('findGmNumberCandidates', () => {
  it('pairs listings that share the exact 8-digit GM number, leading zeros included', () => {
    const { candidates } = findGmNumberCandidates([
      part('b', { gm: ['09600001'] }, 'Hi-Q'),
      part('a', { gm: ['09600001'] }, 'GM'),
      part('c', { gm: ['9600001'] }), // 7 digits: a different number
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      key: 'SAME_GM_NUMBER:09600001:a|b',
      status: 'CANDIDATE',
      relation: null,
      basis: 'SAME_GM_NUMBER',
      number: '09600001',
      a: { catalogPartId: 'a', partBrandName: 'GM' },
      b: { catalogPartId: 'b', partBrandName: 'Hi-Q' },
    });
  });

  it('does not pair numbers that differ by one digit', () => {
    const { candidates, notProposed } = findGmNumberCandidates([
      part('a', { gm: ['96000001'] }),
      part('b', { gm: ['96000002'] }),
    ]);
    expect(candidates).toEqual([]);
    expect(notProposed).toEqual([]);
  });

  it('matches on the canonical form only: separators differ, digits must not', () => {
    const { candidates } = findGmNumberCandidates([
      part('a', { gm: ['96.000.001', '96000001'] }),
      part('b', { gm: ['96000001'] }),
    ]);
    expect(candidates.map((c) => c.number)).toEqual(['96000001']);
    expect(candidates[0].a.asStored).toEqual(['96.000.001']);
  });

  it('does not propose a number whose issuer is not recorded on every listing', () => {
    const { candidates, notProposed } = findGmNumberCandidates([
      part('a', { gm: ['96000001'] }),
      part('b', { oem: ['96000001'] }), // OEM-labelled: issuer unknown
      part('c', { gm: ['96000001'], oem: ['96000001'] }), // unlabelled
    ]);
    expect(candidates).toEqual([]);
    expect(notProposed).toEqual([
      {
        number: '96000001',
        reason: 'issuer_not_recorded',
        parts: [
          { catalogPartId: 'a', label: 'GM' },
          { catalogPartId: 'b', label: 'OEM' },
          { catalogPartId: 'c', label: 'UNLABELLED' },
        ],
      },
    ]);
  });

  it('does not propose a shared GM number that is not 8 digits, nor a shared aftermarket article', () => {
    const { candidates, notProposed } = findGmNumberCandidates([
      part('a', { gm: ['9600001'] }),
      part('b', { gm: ['9600001'] }),
      part('c', { oem: ['ACME100'] }),
      part('d', { oem: ['ACME100'] }),
    ]);
    expect(candidates).toEqual([]);
    expect(notProposed.map((n) => [n.number, n.reason])).toEqual([
      ['9600001', 'gm_but_not_8_digits'],
      ['ACME100', 'issuer_not_recorded'],
    ]);
  });

  it('uses no title, brand or category similarity', () => {
    const a = { ...part('a', { gm: ['96000001'] }), title: 'Brake pads front' };
    const b = { ...part('b', { gm: ['96000009'] }), title: 'Brake pads front' };
    expect(findGmNumberCandidates([a, b]).candidates).toEqual([]);
  });

  it('is deterministic and lists every pair of a shared number', () => {
    const parts = [
      part('c', { gm: ['96000001'] }),
      part('a', { gm: ['96000001'] }),
      part('b', { gm: ['96000001'] }),
    ];
    const keys = findGmNumberCandidates(parts).candidates.map((c) => c.key);
    expect(keys).toEqual([
      'SAME_GM_NUMBER:96000001:a|b',
      'SAME_GM_NUMBER:96000001:a|c',
      'SAME_GM_NUMBER:96000001:b|c',
    ]);
    expect(
      findGmNumberCandidates([...parts].reverse()).candidates.map((c) => c.key),
    ).toEqual(keys);
  });
});
