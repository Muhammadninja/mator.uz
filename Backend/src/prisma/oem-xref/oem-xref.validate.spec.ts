import {
  dataset,
  evidence,
  record,
  side,
  TODAY,
} from '../../../test/utils/oem-xref-fixture';
import type { XrefRecord } from './oem-xref.types';
import { manufacturerKey, validateXrefDataset } from './oem-xref.validate';

const run = (records: unknown[], name = 'fixture') =>
  validateXrefDataset(
    { ...dataset([], name), records },
    { expectedName: name, today: TODAY },
  );
const codes = (records: unknown[]) => run(records).issues.map((i) => i.code);

const gm = (id: string, n = '96000001') => side(id, 'GM', n);
const sameGm = (o: Partial<XrefRecord> = {}) =>
  record('xref-0001', gm('a'), gm('b'), { basis: 'SAME_GM_NUMBER', ...o });
const verifiedSamePart = (o: Partial<XrefRecord> = {}) =>
  record('xref-0002', gm('a'), side('b', 'Acme', 'ACME-100'), {
    status: 'VERIFIED',
    relation: 'SAME_PART',
    evidence: [evidence('96000001', 'ACME-100')],
    ...o,
  });

describe('validateXrefDataset: the dataset itself', () => {
  it('accepts a well-formed dataset', () => {
    expect(run([sameGm(), verifiedSamePart()]).issues).toEqual([]);
  });

  it('refuses a retired dataset, another format version or a dataset under another name', () => {
    const base = dataset([sameGm()], 'wave-4');
    const check = (raw: unknown, expectedName = 'wave-4') =>
      validateXrefDataset(raw, { expectedName, today: TODAY });
    expect(check({ ...base, retired: true }).issues.map((i) => i.code)).toEqual(
      ['dataset_retired'],
    );
    expect(
      check({ ...base, formatVersion: 2 }).issues.map((i) => i.code),
    ).toEqual(['unsupported_format']);
    expect(check(base, 'wave-5').issues.map((i) => i.code)).toEqual([
      'dataset_name_mismatch',
    ]);
    expect(check({ ...base, retired: true }).records).toEqual([]);
  });

  it('refuses a duplicate record id', () => {
    expect(codes([sameGm(), sameGm()])).toEqual(['duplicate_id']);
  });
});

describe('validateXrefDataset: numbers and manufacturers', () => {
  it('keeps leading zeros: a normalized value without them is refused', () => {
    const s = { ...gm('a', '09600001'), normalized: '9600001' };
    expect(codes([sameGm({ from: s })])).toContain('normalized_mismatch');
    expect(
      codes([sameGm({ from: gm('a', '09600001'), to: gm('b', '09600001') })]),
    ).toEqual([]);
  });

  it('refuses characters normalizeOem would silently drop (a Cyrillic look-alike)', () => {
    expect(
      codes([sameGm({ from: { ...gm('a'), partNumber: '96000001А' } })]),
    ).toContain('bad_part_number');
  });

  it('refuses letters in a GM number and too weak a number', () => {
    expect(codes([sameGm({ from: gm('a', '9600A001') })])).toContain(
      'gm_number_format',
    );
    expect(codes([sameGm({ from: side('a', 'Acme', 'AB1') })])).toContain(
      'number_too_weak',
    );
  });

  it('treats numbers of different manufacturers as different numbers', () => {
    expect(manufacturerKey('Hi-Q')).toBe(manufacturerKey('HI Q'));
    expect(manufacturerKey('GM')).not.toBe(manufacturerKey('Mando'));
    // GM 96000001 and Mando 96000001 on one listing are two numbers, not a self-reference.
    expect(codes([sameGm({ to: side('a', 'Mando', '96000001') })])).toEqual([]);
    // A supersession never crosses manufacturers.
    const r = verifiedSamePart({
      relation: 'SUPERSEDED_BY',
      to: side('b', 'Mando', '96000002'),
      evidence: [
        evidence('96000001', '96000002', { asserts: 'SUPERSEDED_BY' }),
      ],
    });
    expect(codes([r])).toContain('supersession_across_manufacturers');
  });

  it('refuses the same number on the same listing on both sides', () => {
    expect(codes([sameGm({ to: gm('a') })])).toEqual(['self_reference']);
  });
});

describe('validateXrefDataset: statuses', () => {
  it('a CANDIDATE needs a basis but no source', () => {
    expect(codes([sameGm({ basis: null })])).toEqual([
      'candidate_without_basis',
    ]);
    expect(codes([sameGm({ evidence: [] })])).toEqual([]);
  });

  it('a VERIFIED record without a source is a provenance error', () => {
    const { records, issues } = run([verifiedSamePart({ evidence: [] })]);
    expect(issues).toEqual([
      expect.objectContaining({
        category: 'provenance',
        code: 'verified_without_source',
        severity: 'error',
      }),
    ]);
    expect(records).toHaveLength(1); // still visible to the planner, blocked there
  });

  it('a VERIFIED record cannot relate a number to itself', () => {
    expect(
      codes([
        sameGm({
          status: 'VERIFIED',
          relation: 'SAME_PART',
          evidence: [evidence('96000001', '96000001')],
        }),
      ]),
    ).toContain('identical_numbers_not_verifiable');
  });

  it('a CANDIDATE with sources stays a CANDIDATE: never promoted automatically', () => {
    const r = sameGm({
      relation: 'SAME_PART',
      evidence: [evidence('96000001', '96000001')],
    });
    const { records, issues } = run([r]);
    expect(records[0].status).toBe('CANDIDATE');
    expect(issues.map((i) => [i.code, i.severity])).toEqual([
      ['candidate_not_promoted', 'warning'],
    ]);
  });

  it('a REJECTED record must say why', () => {
    expect(codes([sameGm({ status: 'REJECTED' })])).toEqual([
      'rejection_missing',
    ]);
    const rejection = {
      reason: 'DIFFERENT_POSITION' as const,
      detail: 'front vs rear',
      reviewedBy: 'catalog-review',
      reviewedOn: '2026-11-12',
    };
    expect(codes([sameGm({ status: 'REJECTED', rejection })])).toEqual([]);
    expect(codes([sameGm({ rejection })])).toEqual([
      'rejection_on_open_record',
    ]);
  });
});

describe('validateXrefDataset: provenance', () => {
  const withEvidence = (o: Parameters<typeof evidence>[2]) =>
    verifiedSamePart({ evidence: [evidence('96000001', 'ACME-100', o)] });

  it('a source without an exact locator is refused', () => {
    expect(codes([withEvidence({ locator: '' })])).toContain(
      'no_exact_locator',
    );
    expect(codes([withEvidence({ locator: 'see the catalog' })])).toContain(
      'no_exact_locator',
    );
  });

  it('every provenance field is required', () => {
    expect(codes([withEvidence({ documentId: ' ' })])).toContain(
      'no_document_id',
    );
    expect(codes([withEvidence({ retrievedOn: '2026-12-01' })])).toContain(
      'bad_retrieved_on',
    );
    expect(
      codes([withEvidence({ url: 'http://gm.example.com/epc' })]),
    ).toContain('bad_url');
    expect(codes([withEvidence({ statement: '' })])).toContain('no_statement');
    expect(
      codes([
        withEvidence({
          type: 'LICENSED_CATALOG',
          publisher: 'Vendor',
          licence: null,
        }),
      ]),
    ).toEqual(['no_licence']);
  });

  it('refuses inadmissible source types and non-manufacturer "official" sources', () => {
    expect(
      codes([withEvidence({ type: 'SELLER_LISTING' as never })]),
    ).toContain('inadmissible_source_type');
    expect(codes([withEvidence({ publisher: 'Some Forum' })])).toEqual([
      'not_official_source',
    ]);
  });

  it('refuses the demo CSV and any repository file as a source', () => {
    expect(
      codes([withEvidence({ documentId: 'prisma/data/oem-catalog.csv' })]),
    ).toContain('untrusted_source');
    expect(
      codes([
        withEvidence({
          documentId: 'GM EPC',
          url: 'https://example.com/oem-catalog.csv',
        }),
      ]),
    ).toContain('untrusted_source');
    expect(
      codes([withEvidence({ documentId: 'src/prisma/seed-data/x.ts' })]),
    ).toContain('untrusted_source');
  });

  it('the source must cite both exact numbers in the record direction', () => {
    expect(
      codes([
        verifiedSamePart({ evidence: [evidence('96000001', 'ACME-101')] }),
      ]),
    ).toEqual(['evidence_cites_other_numbers']);
    expect(
      codes([
        verifiedSamePart({ evidence: [evidence('ACME 100', '96.000.001')] }),
      ]),
    ).toEqual(['evidence_direction_reversed']);
    expect(
      codes([
        verifiedSamePart({ evidence: [evidence('96.000.001', 'ACME 100')] }),
      ]),
    ).toEqual([]);
  });

  it('an official supersession names its direction: old number → new number', () => {
    const supersession = record(
      'xref-0003',
      gm('a', '96000001'),
      gm('b', '96000002'),
      {
        status: 'VERIFIED',
        relation: 'SUPERSEDED_BY',
        evidence: [
          evidence('96000001', '96000002', {
            type: 'SUPERSESSION_BULLETIN',
            asserts: 'SUPERSEDED_BY',
          }),
        ],
      },
    );
    expect(codes([supersession])).toEqual([]);
    const reversed = {
      ...supersession,
      evidence: [
        evidence('96000002', '96000001', {
          type: 'SUPERSESSION_BULLETIN',
          asserts: 'SUPERSEDED_BY',
        }),
      ],
    };
    expect(codes([reversed])).toEqual(['evidence_direction_reversed']);
    const bulletinScope = {
      ...supersession,
      relation: 'SAME_PART' as const,
      evidence: [
        evidence('96000001', '96000002', { type: 'SUPERSESSION_BULLETIN' }),
      ],
    };
    expect(codes([bulletinScope])).toEqual(['bulletin_scope']);
  });

  it('flags contradicting sources inside one record', () => {
    const r = verifiedSamePart({
      evidence: [
        evidence('96000001', 'ACME-100'),
        evidence('96000001', 'ACME-100', { asserts: 'NO_RELATION' }),
      ],
    });
    expect(codes([r])).toEqual(['contradicting_evidence']);
  });
});

describe('validateXrefDataset: no vehicle data', () => {
  it('refuses fitment fields on a record, a side or a source', () => {
    const r = {
      ...sameGm(),
      vehicles: [{ make: 'Chevrolet', model: 'Cobalt' }],
    };
    expect(codes([r])).toEqual(['fitment_not_allowed']);
    expect(run([r]).records).toEqual([]);
    expect(
      codes([sameGm({ from: { ...gm('a'), isUniversal: true } as never })]),
    ).toEqual(['fitment_not_allowed']);
    const e = { ...evidence('96000001', 'ACME-100'), modelYears: '2014-2020' };
    expect(codes([verifiedSamePart({ evidence: [e as never] })])).toEqual([
      'fitment_not_allowed',
    ]);
  });
});
