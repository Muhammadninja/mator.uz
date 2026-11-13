/**
 * Review points (2026-11-13): symmetric pairs dedupe, direction is never
 * inverted, a number in both arrays stays ambiguous, an unsourced candidate is
 * never trusted or buyer-visible.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  dataset,
  evidence,
  part,
  record,
  side,
  snapshot,
  TODAY,
} from '../../../test/utils/oem-xref-fixture';
import { OEM_XREF_DATASETS } from './oem-xref.datasets';
import { isXrefPlanBlocked, planOemCrossReference } from './oem-xref.plan';
import { formatXrefReport } from './oem-xref.report';
import type { XrefRecord } from './oem-xref.types';

const CATALOG = snapshot([
  part('gm-pads', { gm: ['96000001'] }, 'GM'),
  part('acme-pads', { gm: ['96000001'], oem: ['ACME-100', 'ACME100'] }, 'Acme'),
  part('old-gm', { gm: ['96000002'] }, 'GM'),
  part('oem-only', { oem: ['96000005'] }, 'Acme'),
]);

const plan = (records: XrefRecord[], catalog = CATALOG) =>
  planOemCrossReference(dataset(records), catalog, {
    datasetName: 'fixture',
    today: TODAY,
  });
const codesOf = (p: ReturnType<typeof plan>) => p.issues.map((i) => i.code);

const gm = (id: string, n = '96000001') => side(id, 'GM', n);
const samePart = (id = 'xref-0001', o: Partial<XrefRecord> = {}) =>
  record(id, gm('gm-pads'), side('acme-pads', 'Acme', 'ACME-100'), {
    status: 'VERIFIED',
    relation: 'SAME_PART',
    evidence: [evidence('96000001', 'ACME-100')],
    ...o,
  });
const rejection = {
  reason: 'SOURCE_SHOWS_DIFFERENT_PARTS' as const,
  detail: 'fixture',
  reviewedBy: 'catalog-review',
  reviewedOn: '2026-11-12',
};

describe('review: symmetric pairs are one pair', () => {
  const acmeSide = () => side('acme-pads', 'Acme', 'ACME-100');
  const swap = (r: XrefRecord, id: string): XrefRecord => ({
    ...r,
    id,
    from: r.to,
    to: r.from,
    evidence: r.evidence.map((e) => ({
      ...e,
      cites: { from: e.cites.to, to: e.cites.from },
    })),
  });

  it.each(['SAME_PART', 'INTERCHANGEABLE'] as const)(
    '%s A–B and B–A are a duplicate',
    (relation) => {
      const ab = samePart('xref-0001', {
        relation,
        evidence: [evidence('96000001', 'ACME-100', { asserts: relation })],
      });
      expect(codesOf(plan([ab, swap(ab, 'xref-0002')]))).toEqual([
        'duplicate_reversed',
      ]);
    },
  );

  it('a candidate (no relation) A–B and B–A are a duplicate', () => {
    const ab = record('xref-0001', gm('gm-pads'), acmeSide());
    expect(codesOf(plan([ab, swap(ab, 'xref-0002')]))).toEqual([
      'duplicate_reversed',
    ]);
  });

  it('a reversed dataset record still covers the finder pair (no second candidate)', () => {
    const ba = record('xref-0001', gm('acme-pads'), gm('gm-pads'), {
      basis: 'SAME_GM_NUMBER',
    });
    const p = plan([ba]);
    expect(p.newCandidates).toEqual([]);
    expect(p.knownCandidates.map((k) => k.recordId)).toEqual(['xref-0001']);
  });
});

describe('review: direction is kept, never inverted', () => {
  const bulletin = (from: string, to: string) =>
    evidence(from, to, {
      type: 'SUPERSESSION_BULLETIN',
      asserts: 'SUPERSEDED_BY',
    });
  const oldToNew = (o: Partial<XrefRecord> = {}) =>
    record('xref-0020', gm('old-gm', '96000002'), gm('gm-pads', '96000001'), {
      status: 'VERIFIED',
      relation: 'SUPERSEDED_BY',
      evidence: [bulletin('96000002', '96000001')],
      ...o,
    });
  const replacement = (
    id: string,
    from: ReturnType<typeof side>,
    to: ReturnType<typeof side>,
  ) =>
    record(id, from, to, {
      status: 'VERIFIED',
      relation: 'OFFICIAL_REPLACEMENT',
      evidence: [
        evidence(from.partNumber, to.partNumber, {
          asserts: 'OFFICIAL_REPLACEMENT',
        }),
      ],
    });

  it('old → new stays old → new: exactly one record, no reverse claim is derived', () => {
    const p = plan([oldToNew()]);
    expect(p.verified).toHaveLength(1);
    expect(p.verified[0].record.from.normalized).toBe('96000002');
    expect(p.verified[0].record.to.normalized).toBe('96000001');
    expect(p.pendingImport.verified).toEqual(['xref-0020']);
    expect(formatXrefReport(p, 'x')).toMatch(
      /from: GM 96000002[^\n]*\n\s+to: GM 96000001/,
    );
  });

  it('the same directional claim twice is a duplicate; the opposite direction is a different claim', () => {
    const ab = replacement(
      'xref-0001',
      gm('gm-pads'),
      side('acme-pads', 'Acme', 'ACME-100'),
    );
    const again = { ...ab, id: 'xref-0002' };
    expect(codesOf(plan([ab, again]))).toEqual(['duplicate']);
    const ba = replacement(
      'xref-0003',
      side('acme-pads', 'Acme', 'ACME-100'),
      gm('gm-pads'),
    );
    expect(plan([ab, ba]).issues).toEqual([]);
  });

  it('rejecting B → A does not contradict a verified A → B', () => {
    const rejectedReverse = record(
      'xref-0021',
      gm('gm-pads', '96000001'),
      gm('old-gm', '96000002'),
      {
        status: 'REJECTED',
        relation: 'SUPERSEDED_BY',
        rejection,
      },
    );
    const p = plan([oldToNew(), rejectedReverse]);
    expect(p.issues).toEqual([]);
    expect(p.pendingImport).toMatchObject({
      verified: ['xref-0020'],
      rejected: ['xref-0021'],
    });
  });

  it('rejecting the same direction, or any relation, does contradict it', () => {
    const sameWay = record(
      'xref-0021',
      gm('old-gm', '96000002'),
      gm('gm-pads', '96000001'),
      {
        status: 'REJECTED',
        relation: 'SUPERSEDED_BY',
        rejection,
      },
    );
    expect(codesOf(plan([oldToNew(), sameWay]))).toEqual([
      'verified_and_rejected',
      'verified_and_rejected',
    ]);
    const anyRelation = {
      ...sameWay,
      relation: null,
      from: sameWay.to,
      to: sameWay.from,
    };
    expect(codesOf(plan([oldToNew(), anyRelation]))).toEqual([
      'verified_and_rejected',
      'verified_and_rejected',
    ]);
  });
});

describe('review: a number in both arrays stays ambiguous', () => {
  const ambiguous = snapshot([
    part('u1', { gm: ['96000007'], oem: ['96000007'] }),
    part('u2', { gm: ['96.000.007'], oem: ['96000007'] }),
  ]);

  it('is never proposed as a GM candidate, even 8 digits on both listings', () => {
    const p = plan([], ambiguous);
    expect(p.newCandidates).toEqual([]);
    expect(p.notProposed).toEqual([
      expect.objectContaining({
        number: '96000007',
        reason: 'issuer_not_recorded',
        parts: [
          { catalogPartId: 'u1', label: 'UNLABELLED' },
          { catalogPartId: 'u2', label: 'UNLABELLED' },
        ],
      }),
    ]);
  });

  it('a SAME_GM_NUMBER basis on it is not reproduced, and its label is reported as is', () => {
    const c = record('xref-0040', gm('u1', '96000007'), gm('u2', '96000007'), {
      basis: 'SAME_GM_NUMBER',
    });
    const p = plan([c], ambiguous);
    expect(codesOf(p)).toEqual(['basis_not_reproduced']);
    expect([p.candidates[0].from.label, p.candidates[0].to.label]).toEqual([
      'UNLABELLED',
      'UNLABELLED',
    ]);
  });
});

describe('review: an unsourced candidate never becomes trusted or buyer-visible', () => {
  it('stays out of verified and out of the verified import list', () => {
    const c = record('xref-0050', gm('gm-pads'), gm('acme-pads'), {
      basis: 'SAME_GM_NUMBER',
    });
    const p = plan([c]);
    expect(p.verified).toEqual([]);
    expect(p.pendingImport.verified).toEqual([]);
    expect(p.withoutProvenance.map((w) => w.recordId)).toEqual(['xref-0050']);
    // Marking it VERIFIED without a source is refused, not imported.
    const forced = plan([{ ...c, status: 'VERIFIED', relation: 'SAME_PART' }]);
    expect(forced.pendingImport.verified).toEqual([]);
    expect(isXrefPlanBlocked(forced)).toBe(true);
  });

  it('every VERIFIED record of a registered dataset carries a complete source', () => {
    for (const [name, ds] of Object.entries(OEM_XREF_DATASETS)) {
      const p = planOemCrossReference(ds, CATALOG, {
        datasetName: name,
        today: TODAY,
      });
      const provenance = p.issues.filter(
        (i) => i.category === 'provenance' && i.severity === 'error',
      );
      expect(provenance).toEqual([]);
      for (const v of p.verified)
        expect(v.record.evidence.length).toBeGreaterThan(0);
    }
  });

  it('no application code imports the pipeline, so nothing buyer-facing can read a candidate', () => {
    const src = join(__dirname, '../..');
    const own = join(__dirname);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, e.name);
        if (e.isDirectory()) {
          if (path !== own) walk(path);
        } else if (
          e.name.endsWith('.ts') &&
          !path.endsWith('oem-xref-wave4.dataset.ts') &&
          /oem-xref/.test(readFileSync(path, 'utf8'))
        )
          offenders.push(path.slice(src.length + 1));
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});
