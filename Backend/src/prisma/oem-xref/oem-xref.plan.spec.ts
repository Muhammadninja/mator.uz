import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  dataset,
  deepFreeze,
  evidence,
  part,
  record,
  side,
  snapshot,
  TODAY,
} from '../../../test/utils/oem-xref-fixture';
import { normalizeOem } from '../../common/normalize-oem.util';
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

describe('planOemCrossReference: candidates', () => {
  it('reports the listings sharing an exact GM number as new candidates, never as compatible', () => {
    const p = plan([]);
    expect(p.newCandidates.map((c) => c.key)).toEqual([
      'SAME_GM_NUMBER:96000001:acme-pads|gm-pads',
    ]);
    expect(p.newCandidates[0]).toMatchObject({
      status: 'CANDIDATE',
      relation: null,
    });
    expect(p.verified).toEqual([]);
    expect(p.pendingImport.verified).toEqual([]);
    expect(isXrefPlanBlocked(p)).toBe(false);
  });

  it('a candidate in the dataset with every source it could want is still a candidate', () => {
    const c = record('xref-0009', gm('gm-pads'), gm('acme-pads'), {
      basis: 'SAME_GM_NUMBER',
      relation: 'SAME_PART',
      evidence: [evidence('96000001', '96000001')],
    });
    const p = plan([c]);
    expect(p.verified).toEqual([]);
    expect(p.candidates.map((x) => x.record.status)).toEqual(['CANDIDATE']);
    expect(p.pendingImport).toEqual({
      verified: [],
      rejected: [],
      candidates: ['xref-0009'],
    });
    expect(p.knownCandidates.map((k) => k.recordId)).toEqual(['xref-0009']);
    expect(p.newCandidates).toEqual([]);
  });

  it('a candidate without a source is listed as lacking provenance, not as an error', () => {
    const c = record('xref-0009', gm('gm-pads'), gm('acme-pads'), {
      basis: 'SAME_GM_NUMBER',
    });
    const p = plan([c]);
    expect(p.withoutProvenance).toEqual([
      { recordId: 'xref-0009', status: 'CANDIDATE', why: 'no source cited' },
    ]);
    expect(isXrefPlanBlocked(p)).toBe(false);
  });

  it('a sound rejection keeps the pair from being proposed again', () => {
    const r = record('xref-0010', gm('gm-pads'), gm('acme-pads'), {
      status: 'REJECTED',
      basis: 'SAME_GM_NUMBER',
      rejection,
    });
    const p = plan([r]);
    expect(p.newCandidates).toEqual([]);
    expect(p.suppressedCandidates.map((s) => s.recordId)).toEqual([
      'xref-0010',
    ]);
    expect(p.pendingImport.rejected).toEqual(['xref-0010']);
  });

  it('flags a SAME_GM_NUMBER basis the snapshot no longer supports', () => {
    const c = record('xref-0011', gm('gm-pads'), gm('oem-only', '96000005'), {
      basis: 'SAME_GM_NUMBER',
    });
    expect(codesOf(plan([c]))).toEqual([
      'issuer_label_differs',
      'basis_not_reproduced',
    ]);
  });
});

describe('planOemCrossReference: catalog checks', () => {
  it('a verified, sourced, catalog-consistent record is importable', () => {
    const p = plan([samePart()]);
    expect(p.issues).toEqual([]);
    expect(p.pendingImport.verified).toEqual(['xref-0001']);
    expect(p.verified[0].to).toMatchObject({
      found: true,
      label: 'OEM',
      asStored: ['ACME-100'],
    });
  });

  it('reports a side whose listing is not in the catalog', () => {
    const p = plan([
      samePart('xref-0001', { to: side('gone', 'Acme', 'ACME-100') }),
    ]);
    expect(codesOf(p)).toEqual(['part_not_in_catalog']);
    expect(p.verified[0].importable).toBe(false);
    expect(isXrefPlanBlocked(p)).toBe(true);
  });

  it("reports a conflict with the listing's own numbers", () => {
    const notCarried = samePart('xref-0001', {
      to: side('acme-pads', 'Acme', 'ACME-101'),
      evidence: [evidence('96000001', 'ACME-101')],
    });
    expect(codesOf(plan([notCarried]))).toEqual(['number_not_on_listing']);
    // the listing labels 96000001 GM, the record calls it an Acme number
    const r = samePart('xref-0001', {
      to: side('acme-pads', 'Acme', '96000001'),
      evidence: [evidence('96000001', '96000001')],
    });
    expect(codesOf(plan([r]))).toEqual(['issuer_label_conflict']);
  });
});

describe('planOemCrossReference: duplicates and conflicts', () => {
  it('finds the same cross-reference twice', () => {
    expect(
      codesOf(plan([samePart('xref-0001'), samePart('xref-0002')])),
    ).toEqual(['duplicate']);
  });

  it('finds a symmetric pair repeated in reverse order', () => {
    const reversed = samePart('xref-0002', {
      from: side('acme-pads', 'Acme', 'ACME-100'),
      to: gm('gm-pads'),
      evidence: [evidence('ACME-100', '96000001')],
    });
    expect(codesOf(plan([samePart('xref-0001'), reversed]))).toEqual([
      'duplicate_reversed',
    ]);
  });

  it('flags sources that contradict each other across records', () => {
    const rejected = samePart('xref-0002', {
      status: 'REJECTED',
      relation: null,
      evidence: [],
      rejection,
    });
    const p = plan([samePart('xref-0001'), rejected]);
    expect(codesOf(p)).toEqual([
      'verified_and_rejected',
      'verified_and_rejected',
    ]);
    expect(p.pendingImport).toEqual({
      verified: [],
      rejected: [],
      candidates: [],
    });
  });

  it('an official supersession keeps its direction; a cycle is a conflict', () => {
    const bulletin = (from: string, to: string) =>
      evidence(from, to, {
        type: 'SUPERSESSION_BULLETIN',
        asserts: 'SUPERSEDED_BY',
      });
    const forward = record(
      'xref-0020',
      gm('old-gm', '96000002'),
      gm('gm-pads', '96000001'),
      {
        status: 'VERIFIED',
        relation: 'SUPERSEDED_BY',
        evidence: [bulletin('96000002', '96000001')],
      },
    );
    expect(plan([forward]).issues).toEqual([]);
    const back = record(
      'xref-0021',
      gm('gm-pads', '96000001'),
      gm('old-gm', '96000002'),
      {
        status: 'VERIFIED',
        relation: 'SUPERSEDED_BY',
        evidence: [bulletin('96000001', '96000002')],
      },
    );
    expect(codesOf(plan([forward, back]))).toEqual([
      'supersession_cycle',
      'supersession_cycle',
    ]);
  });

  it('marks an open candidate already decided by another record', () => {
    const c = record(
      'xref-0030',
      gm('gm-pads'),
      side('acme-pads', 'Acme', 'ACME-100'),
    );
    expect(
      plan([samePart(), c]).issues.map((i) => [i.code, i.severity]),
    ).toEqual([['candidate_already_decided', 'warning']]);
  });
});

describe('dry-run guarantees', () => {
  it('changes nothing: the dataset and the snapshot are left exactly as they were', () => {
    const ds = deepFreeze(
      dataset([
        samePart(),
        record('xref-0009', gm('gm-pads'), gm('acme-pads')),
      ]),
    );
    const catalog = deepFreeze(snapshot(CATALOG.parts.map((p) => ({ ...p }))));
    const before = JSON.stringify([ds, catalog]);
    const p = planOemCrossReference(ds, catalog, {
      datasetName: 'fixture',
      today: TODAY,
    });
    expect(JSON.stringify([ds, catalog])).toBe(before);
    expect(p.writes).toEqual({ crossReferences: 0, fitment: 0, parts: 0 });
  });

  it('creates no fitment: the plan carries no vehicle data, even for a verified pair', () => {
    const p = plan([samePart()]);
    expect(JSON.stringify(p)).not.toMatch(
      /vehicle|fitment_binding|make_?name|model_?name|isUniversal/i,
    );
  });

  it('the pipeline and its CLI never load a database client, .env or fitment table', () => {
    const files = [
      'oem-xref.catalog.ts',
      'oem-xref.checks.ts',
      'oem-xref.evidence.ts',
      'oem-xref.datasets.ts',
      'oem-xref.plan.ts',
      'oem-xref.report.ts',
      'oem-xref.types.ts',
      'oem-xref.validate.ts',
      '../seed-data/oem-xref-wave4.dataset.ts',
      '../../../scripts/oem-cross-reference-dry-run.ts',
    ].map((f) => readFileSync(join(__dirname, f), 'utf8'));
    for (const source of files) {
      expect(source).not.toMatch(
        /@prisma\/client|PrismaClient|dotenv|ioredis|\bfetch\(|node:https?/,
      );
      expect(source).not.toMatch(
        /fitmentBinding|catalogPartFit|partCompatibilit|oemCompatibility|part_vehicle/,
      );
    }
  });

  it('the snapshot SQL only reads, inside a rolled-back READ ONLY transaction', () => {
    const sql = readFileSync(
      join(__dirname, '../../../scripts/sql/oem-cross-reference-snapshot.sql'),
      'utf8',
    );
    const statements = sql
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    expect(statements).toMatch(/BEGIN READ ONLY;/);
    expect(statements).toMatch(/ROLLBACK;\s*$/);
    expect(statements).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|COPY)\b/i,
    );
    expect(statements).not.toMatch(
      /fitment_bindings|catalog_part_fits|oem_compatibility|vehicles/,
    );
  });
});

describe('the registered Wave 4 dataset', () => {
  const wave4 = OEM_XREF_DATASETS['wave-4'];

  it('is valid, names itself by its key and has no unsourced claim', () => {
    const p = planOemCrossReference(wave4, CATALOG, {
      datasetName: 'wave-4',
      today: TODAY,
    });
    expect(p.issues).toEqual([]);
    for (const [key, ds] of Object.entries(OEM_XREF_DATASETS))
      expect(ds.name).toBe(key);
  });

  it('carries none of the 12 demo rows of prisma/data/oem-catalog.csv as a verified pair', () => {
    const csv = readFileSync(
      join(__dirname, '../../../prisma/data/oem-catalog.csv'),
      'utf8',
    );
    const demoRows = csv
      .trim()
      .split('\n')
      .slice(1)
      .map(
        (line) =>
          new Set(
            line
              .split(',')[6]
              .split('|')
              .map((n) => normalizeOem(n)),
          ),
      );
    expect(demoRows).toHaveLength(12);
    for (const ds of Object.values(OEM_XREF_DATASETS))
      for (const r of ds.records.filter((x) => x.status === 'VERIFIED'))
        expect(
          demoRows.some(
            (row) => row.has(r.from.normalized) && row.has(r.to.normalized),
          ),
        ).toBe(false);
  });
});

describe('formatXrefReport', () => {
  it('prints every section, empty ones included, and states that nothing is written', () => {
    const text = formatXrefReport(plan([]), 'fixture snapshot');
    for (const heading of [
      '1. New candidates',
      '2. Verified cross-references',
      '3. Rejected records',
      '4. Duplicates',
      '5. Conflicts',
      '6. Records without sufficient provenance',
      '7. Not matched to the catalog',
      '8. Changes a SEPARATE',
    ])
      expect(text).toContain(heading);
    expect(text).toContain('Nothing is written');
    expect(text).toContain('fitment rows: 0');
    expect(text).toContain('a: acme-pads');
  });
});
