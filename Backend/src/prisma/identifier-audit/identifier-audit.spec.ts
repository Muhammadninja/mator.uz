import {
  AuditSnapshotFormatError,
  parseAuditSnapshot,
} from './identifier-audit.snapshot';
import {
  SectionKey,
  auditIdentifiers,
  formatIdentifierAudit,
} from './identifier-audit';

type RawPart = Record<string, unknown>;

function part(id: string, over: RawPart = {}): RawPart {
  return {
    id,
    title: `Part ${id}`,
    part_brand_name: null,
    brand_name: null,
    part_number_type: 'UNKNOWN',
    gm_numbers: [],
    oem_numbers: [],
    is_universal: false,
    created_at: '2026-11-01T00:00:00.000Z',
    listed: true,
    has_fitment: true,
    source_part_number: null,
    source_system: null,
    ...over,
  };
}

const snapshotOf = (parts: RawPart[]) =>
  JSON.stringify({
    kind: 'catalog-identifier-audit',
    format_version: 1,
    captured_at: '2026-11-13T00:00:00Z',
    database: 'fixture',
    parts,
  });

const audit = (parts: RawPart[]) =>
  auditIdentifiers(parseAuditSnapshot(snapshotOf(parts)));
const section = (parts: RawPart[], key: SectionKey) =>
  audit(parts).sections.find((s) => s.key === key)!;

describe('identifier audit — snapshot format', () => {
  it('refuses another kind or version', () => {
    expect(() =>
      parseAuditSnapshot('{"kind":"another-snapshot","format_version":1}'),
    ).toThrow(AuditSnapshotFormatError);
    expect(() => parseAuditSnapshot('not json')).toThrow(
      AuditSnapshotFormatError,
    );
  });

  it('refuses a number given as a JSON number (its leading zeros would be gone)', () => {
    expect(() =>
      parseAuditSnapshot(snapshotOf([part('a', { gm_numbers: [9593992] })])),
    ).toThrow(/array of strings/);
  });

  it('refuses a duplicate part id', () => {
    expect(() =>
      parseAuditSnapshot(snapshotOf([part('a'), part('a')])),
    ).toThrow(/twice/);
  });
});

describe('identifier audit — findings', () => {
  it('parts without any usable number, listed counted apart', () => {
    const s = section(
      [
        part('none'),
        part('none_hidden', { listed: false }),
        part('ok', { gm_numbers: ['96879797'] }),
      ],
      'no_usable_number',
    );
    expect([s.parts, s.listedParts]).toEqual([2, 1]);
  });

  it('a written number without its canonical search form', () => {
    const s = section(
      [
        part('missing', { oem_numbers: ['SP-1362'] }),
        part('complete', { oem_numbers: ['SP-1362', 'SP1362'] }),
      ],
      'missing_canonical_form',
    );
    expect(s.parts).toBe(1);
    expect(s.findings[0]).toContain('missing');
  });

  it('one identifier on several parts (several dealers) vs one number on several manufacturers', () => {
    const parts = [
      part('bosch_1', { oem_numbers: ['SP1362'], part_brand_name: 'Bosch' }),
      part('bosch_2', {
        oem_numbers: ['SP-1362', 'SP1362'],
        part_brand_name: 'BOSCH',
      }),
      part('denso', { oem_numbers: ['SP1362'], part_brand_name: 'Denso' }),
    ];
    const dup = section(parts, 'duplicate_identifier');
    expect([dup.numbers, dup.parts]).toEqual([1, 2]);
    const makers = section(parts, 'number_on_several_manufacturers');
    expect([makers.numbers, makers.parts]).toEqual([1, 3]);
    // Bosch vs Denso is a collision: an ambiguous search, never a merge.
    expect(section(parts, 'ambiguous_number').numbers).toBe(1);
  });

  it('an unknown manufacturer on a shared number is ambiguous', () => {
    const s = section(
      [
        part('known', { gm_numbers: ['96879797'], part_brand_name: 'GM' }),
        part('unknown', { gm_numbers: ['96879797'] }),
      ],
      'ambiguous_number',
    );
    expect(s.numbers).toBe(1);
    expect(s.findings[0]).toContain('manufacturer unknown');
  });

  it('a number shared by one manufacturer under one label is not ambiguous', () => {
    const s = section(
      [
        part('a', { gm_numbers: ['96879797'], part_brand_name: 'GM' }),
        part('b', { gm_numbers: ['96879797'], part_brand_name: 'GM' }),
      ],
      'ambiguous_number',
    );
    expect(s.numbers).toBe(0);
  });

  it('GM on one listing, OEM on another; and a part type the arrays contradict', () => {
    const s = section(
      [
        part('as_gm', { gm_numbers: ['96879797'] }),
        part('as_oem', { oem_numbers: ['96879797'] }),
        part('typed_gm', { part_number_type: 'GM', oem_numbers: ['12345678'] }),
      ],
      'label_conflict',
    );
    expect(s.parts).toBe(3);
    expect(s.numbers).toBe(1);
  });

  it('malformed: Cyrillic in a stored number, punctuation only, unsearchable source number', () => {
    const s = section(
      [
        part('cyr', { gm_numbers: ['ЗМЗ-406', 'ЗМЗ406'] }),
        part('punct', { oem_numbers: ['---'] }),
        part('src', { source_part_number: 'АБВ 12', oem_numbers: [] }),
        part('fine', { oem_numbers: ['SP-1362', 'SP1362'] }),
      ],
      'malformed_number',
    );
    expect(s.parts).toBe(3);
  });

  it('leading zeros are reported and never collapsed', () => {
    const parts = [
      part('zero', { oem_numbers: ['0986452041'] }),
      part('no_zero', { oem_numbers: ['986452041'] }),
    ];
    const s = section(parts, 'leading_zero');
    expect([s.numbers, s.parts]).toEqual([1, 1]);
    // Two numbers, not one: nothing is shared.
    expect(audit(parts).distinctNumbers).toBe(2);
    expect(section(parts, 'ambiguous_number').numbers).toBe(0);
  });

  it('parts with several numbers; parts with no fitment that are not universal', () => {
    const parts = [
      part('many', { gm_numbers: ['96879797'], oem_numbers: ['SP1362'] }),
      part('no_fit', { has_fitment: false }),
      part('universal', { has_fitment: false, is_universal: true }),
    ];
    expect(section(parts, 'several_numbers').parts).toBe(1);
    expect(section(parts, 'no_fitment').findings).toEqual([
      'no_fit "Part no_fit"',
    ]);
  });

  it('a number with no digit is flagged as not searchable as a number', () => {
    expect(
      section(
        [part('word', { oem_numbers: ['FILTER'] })],
        'not_searchable_as_number',
      ).numbers,
    ).toBe(1);
  });

  it('short numbers: found alone, not beside words — listed for review', () => {
    const s = section(
      [
        part('short', { gm_numbers: ['2106'] }),
        part('long', { gm_numbers: ['96879797'] }),
      ],
      'short_number',
    );
    expect([s.numbers, s.parts]).toEqual([1, 1]);
    expect(s.findings[0]).toContain('2106');
  });

  it('imported positions searchable by their code_1c, indexed or not', () => {
    const s = section(
      [
        part('dv_indexed', {
          source_system: 'DRIVERS_VILLAGE',
          source_part_number: '96273708 GMB',
          oem_numbers: ['96273708GMB'],
        }),
        part('dv_not_indexed', {
          source_system: 'DRIVERS_VILLAGE',
          source_part_number: 'АБ-12',
        }),
        part('telegram', { gm_numbers: ['96879797'] }),
      ],
      'source_code_number',
    );
    expect(s.parts).toBe(2);
    expect(s.findings).toEqual([
      'dv_indexed [DRIVERS_VILLAGE]: "96273708 GMB" → "96273708GMB" in oem_numbers',
      'dv_not_indexed [DRIVERS_VILLAGE]: "АБ-12" not indexed',
    ]);
  });

  it('the text report states it is read-only and truncates long sections', () => {
    const parts = Array.from({ length: 25 }, (_, i) => part(`p${i}`));
    const text = formatIdentifierAudit(audit(parts), 'fixture');
    expect(text).toContain('READ-ONLY, nothing was changed');
    expect(text).toContain('… 5 more (use --all)');
  });

  it('never changes its input', () => {
    const snap = parseAuditSnapshot(
      snapshotOf([part('a', { oem_numbers: ['SP-1362'] })]),
    );
    const before = JSON.stringify(snap);
    auditIdentifiers(snap);
    expect(JSON.stringify(snap)).toBe(before);
  });
});
