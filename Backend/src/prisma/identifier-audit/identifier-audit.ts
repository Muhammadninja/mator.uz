import { normalizeOem } from '../../common/normalize-oem.util';
import {
  MAX_PART_NUMBER_LENGTH,
  MIN_NUMBER_BESIDE_WORDS,
  PartIdentifier,
  PartNumberScheme,
  compareIdentifiers,
  hasDroppedCharacters,
  hasLeadingZero,
  identifierKey,
  partNumberKey,
} from '../../common/part-number.util';
import type { AuditPart, AuditSnapshot } from './identifier-audit.snapshot';

/**
 * The part-number data-quality audit (Wave 5). Pure and READ-ONLY: it reports,
 * it never merges, deletes, relabels or rewrites a number. A shared number is
 * a fact to review, not evidence that two parts are the same or
 * interchangeable (that is Wave 4's evidence process).
 *
 * Labels per number follow the projection rule (see listedNumbers below):
 * gm_numbers only → GM, oem_numbers only → OEM, both → UNLABELLED. The Wave 4
 * cross-reference pipeline has the same rule but stays isolated: nothing
 * outside it imports it. A part's
 * manufacturer is its part brand (part_brand_name, else the brand row), null
 * when neither is recorded.
 */

export type SectionKey =
  | 'no_usable_number'
  | 'missing_canonical_form'
  | 'duplicate_identifier'
  | 'number_on_several_manufacturers'
  | 'label_conflict'
  | 'malformed_number'
  | 'leading_zero'
  | 'several_numbers'
  | 'no_fitment'
  | 'ambiguous_number'
  | 'not_searchable_as_number'
  | 'short_number'
  | 'source_code_number';

export interface AuditSection {
  key: SectionKey;
  title: string;
  /** Distinct parts concerned. */
  parts: number;
  /** Of those, parts a buyer can see (BUYER_LISTED_PART, category aside). */
  listedParts: number;
  /** Distinct canonical numbers concerned, where the section is per number. */
  numbers: number | null;
  /** Every finding, one line each, in a stable order. */
  findings: string[];
}

export interface IdentifierAuditReport {
  totalParts: number;
  listedParts: number;
  distinctNumbers: number;
  sections: AuditSection[];
}

interface NumberUse {
  part: AuditPart;
  label: PartIdentifier['scheme'];
  asStored: string[];
}

export const manufacturerOf = (p: AuditPart): string | null =>
  p.partBrandName?.trim() || p.brandName?.trim() || null;

interface ListedNumber {
  canonical: string;
  label: PartNumberScheme;
  /** Every stored spelling, the canonical one dropped when a written one exists. */
  asStored: string[];
}

/** A part's numbers by canonical form, each with its label. */
export function listedNumbers(part: AuditPart): Map<string, ListedNumber> {
  const out = new Map<string, ListedNumber>();
  const add = (stored: string, inGm: boolean) => {
    const canonical = normalizeOem(stored);
    if (!canonical) return;
    const entry = out.get(canonical) ?? {
      canonical,
      label: inGm ? 'GM' : 'OEM',
      asStored: [],
    };
    if (entry.label !== 'UNLABELLED' && entry.label !== (inGm ? 'GM' : 'OEM')) {
      entry.label = 'UNLABELLED';
    }
    if (!entry.asStored.includes(stored)) entry.asStored.push(stored);
    out.set(canonical, entry);
  };
  part.gmNumbers.forEach((n) => add(n, true));
  part.oemNumbers.forEach((n) => add(n, false));
  for (const entry of out.values()) {
    if (entry.asStored.length > 1) {
      entry.asStored = entry.asStored.filter((s) => s !== entry.canonical);
    }
  }
  return out;
}

const identifierOf = (u: NumberUse): PartIdentifier => ({
  scheme: u.label,
  manufacturer: manufacturerOf(u.part),
  original: u.asStored[0],
});

class Section {
  private readonly partIds = new Set<string>();
  private readonly listedIds = new Set<string>();
  private readonly numberSet = new Set<string>();
  private readonly lines: string[] = [];

  constructor(
    readonly key: SectionKey,
    readonly title: string,
    private readonly perNumber: boolean,
  ) {}

  add(parts: AuditPart[], line: string, number?: string): void {
    for (const p of parts) {
      this.partIds.add(p.id);
      if (p.listed) this.listedIds.add(p.id);
    }
    if (number !== undefined) this.numberSet.add(number);
    this.lines.push(line);
  }

  build(): AuditSection {
    return {
      key: this.key,
      title: this.title,
      parts: this.partIds.size,
      listedParts: this.listedIds.size,
      numbers: this.perNumber ? this.numberSet.size : null,
      findings: this.lines,
    };
  }
}

const show = (values: string[]): string =>
  values.map((v) => JSON.stringify(v)).join(', ');

export function auditIdentifiers(
  snapshot: AuditSnapshot,
): IdentifierAuditReport {
  const s = {
    none: new Section(
      'no_usable_number',
      'Parts without any usable part number',
      false,
    ),
    canon: new Section(
      'missing_canonical_form',
      'Numbers stored without their canonical search form',
      false,
    ),
    dup: new Section(
      'duplicate_identifier',
      'One identifier (label + manufacturer + number) on several parts',
      true,
    ),
    makers: new Section(
      'number_on_several_manufacturers',
      'One number on parts of different manufacturers',
      true,
    ),
    label: new Section(
      'label_conflict',
      'Conflicting GM/OEM classification',
      true,
    ),
    bad: new Section('malformed_number', 'Malformed numbers', false),
    zero: new Section(
      'leading_zero',
      'Numbers with a leading zero (kept as written)',
      true,
    ),
    many: new Section(
      'several_numbers',
      'Parts carrying several numbers',
      false,
    ),
    fit: new Section(
      'no_fitment',
      'Parts with no vehicle compatibility (not universal)',
      false,
    ),
    amb: new Section(
      'ambiguous_number',
      'Numbers whose search returns parts of different or unknown owners',
      true,
    ),
    nodigit: new Section(
      'not_searchable_as_number',
      'Numbers without a digit (Wave 5 number search skips them)',
      true,
    ),
    short: new Section(
      'short_number',
      `Short numbers (under ${MIN_NUMBER_BESIDE_WORDS} characters): found when typed alone, not beside words`,
      true,
    ),
    source: new Section(
      'source_code_number',
      'Imported positions searchable by their source code (code_1c, indexed in oem_numbers)',
      false,
    ),
  };

  const uses = new Map<string, NumberUse[]>();
  const parts = [...snapshot.parts].sort((a, b) => (a.id < b.id ? -1 : 1));

  for (const part of parts) {
    const numbers = listedNumbers(part);
    if (numbers.size === 0) s.none.add([part], `${part.id} "${part.title}"`);
    if (numbers.size > 1) {
      s.many.add([part], `${part.id}: ${show([...numbers.keys()])}`);
    }
    if (!part.isUniversal && !part.hasFitment)
      s.fit.add([part], `${part.id} "${part.title}"`);

    for (const [array, values] of [
      ['gm_numbers', part.gmNumbers],
      ['oem_numbers', part.oemNumbers],
    ] as const) {
      for (const stored of values) {
        const canonical = normalizeOem(stored);
        if (canonical && canonical !== stored && !values.includes(canonical)) {
          s.canon.add(
            [part],
            `${part.id}: ${JSON.stringify(stored)} in ${array} lacks ${JSON.stringify(canonical)}`,
          );
        }
        if (!canonical) {
          s.bad.add(
            [part],
            `${part.id}: ${JSON.stringify(stored)} in ${array} has no Latin letter or digit`,
          );
        } else if (hasDroppedCharacters(stored)) {
          s.bad.add(
            [part],
            `${part.id}: ${JSON.stringify(stored)} in ${array} loses characters in its canonical form ${JSON.stringify(canonical)}`,
          );
        } else if (canonical.length > MAX_PART_NUMBER_LENGTH) {
          s.bad.add(
            [part],
            `${part.id}: ${JSON.stringify(stored)} in ${array} is longer than ${MAX_PART_NUMBER_LENGTH}`,
          );
        }
      }
    }
    if (
      part.sourcePartNumber !== null &&
      partNumberKey(part.sourcePartNumber) === null
    ) {
      s.bad.add(
        [part],
        `${part.id}: source part number ${JSON.stringify(part.sourcePartNumber)} is not a searchable number`,
      );
    }
    if (part.sourceSystem !== null && part.sourcePartNumber !== null) {
      const key = partNumberKey(part.sourcePartNumber);
      const indexed = key !== null && part.oemNumbers.includes(key);
      s.source.add(
        [part],
        `${part.id} [${part.sourceSystem}]: ${JSON.stringify(part.sourcePartNumber)} ${indexed ? `→ ${JSON.stringify(key)} in oem_numbers` : 'not indexed'}`,
      );
    }
    if (part.partNumberType !== 'UNKNOWN') {
      const other = part.partNumberType === 'GM' ? 'OEM' : 'GM';
      const off = [...numbers.values()]
        .filter((n) => n.label === other)
        .map((n) => n.canonical);
      if (off.length > 0) {
        s.label.add(
          [part],
          `${part.id}: part_number_type ${part.partNumberType} but ${show(off)} only in the ${other} array`,
        );
      }
    }

    for (const n of numbers.values()) {
      const list = uses.get(n.canonical) ?? [];
      list.push({ part, label: n.label, asStored: n.asStored });
      uses.set(n.canonical, list);
    }
  }

  for (const [number, list] of [...uses].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const owners = list.map((u) => u.part);
    if (hasLeadingZero(number))
      s.zero.add(
        owners,
        `${number}: ${owners.map((p) => p.id).join(', ')}`,
        number,
      );
    if (!/[0-9]/.test(number))
      s.nodigit.add(
        owners,
        `${number}: ${owners.map((p) => p.id).join(', ')}`,
        number,
      );
    if (/[0-9]/.test(number) && number.length < MIN_NUMBER_BESIDE_WORDS)
      s.short.add(
        owners,
        `${number}: ${owners.map((p) => `${p.id} "${p.title}"`).join(', ')}`,
        number,
      );
    if (list.length < 2) continue;

    const byKey = new Map<string, AuditPart[]>();
    for (const u of list) {
      const key = identifierKey(identifierOf(u));
      byKey.set(key, [...(byKey.get(key) ?? []), u.part]);
    }
    for (const [key, same] of byKey) {
      if (same.length > 1)
        s.dup.add(same, `${key}: ${same.map((p) => p.id).join(', ')}`, number);
    }

    const makers = new Set(
      owners
        .map(manufacturerOf)
        .filter((m): m is string => !!m)
        .map((m) => m.toLowerCase()),
    );
    if (makers.size > 1) {
      s.makers.add(
        owners,
        `${number}: ${list.map((u) => `${u.part.id} (${manufacturerOf(u.part)})`).join(', ')}`,
        number,
      );
    }
    const labels = new Set(list.map((u) => u.label));
    if (labels.has('GM') && labels.has('OEM')) {
      s.label.add(
        owners,
        `${number}: labelled GM on ${list
          .filter((u) => u.label === 'GM')
          .map((u) => u.part.id)
          .join(', ')} and OEM on ${list
          .filter((u) => u.label === 'OEM')
          .map((u) => u.part.id)
          .join(', ')}`,
        number,
      );
    }
    const collides = list.some((a, i) =>
      list
        .slice(i + 1)
        .some(
          (b) =>
            compareIdentifiers(identifierOf(a), identifierOf(b)) ===
            'collision',
        ),
    );
    if (collides) {
      s.amb.add(
        owners,
        `${number}: ${list.map((u) => `${u.part.id} [${u.label}, ${manufacturerOf(u.part) ?? 'manufacturer unknown'}]`).join(', ')}`,
        number,
      );
    }
  }

  return {
    totalParts: parts.length,
    listedParts: parts.filter((p) => p.listed).length,
    distinctNumbers: uses.size,
    sections: Object.values(s).map((x) => x.build()),
  };
}

/** The report as text: counts first, then up to `examples` findings per section. */
export function formatIdentifierAudit(
  report: IdentifierAuditReport,
  source: string,
  examples = 20,
): string {
  const out = [
    'Catalog part-number audit (Wave 5) — READ-ONLY, nothing was changed',
    `Source: ${source}`,
    `Parts: ${report.totalParts} (${report.listedParts} listed); distinct numbers: ${report.distinctNumbers}`,
    '',
  ];
  for (const sec of report.sections) {
    const nums = sec.numbers === null ? '' : `, ${sec.numbers} numbers`;
    out.push(
      `## ${sec.title}: ${sec.parts} parts (${sec.listedParts} listed)${nums}`,
    );
    for (const line of sec.findings.slice(0, examples)) out.push(`  - ${line}`);
    if (sec.findings.length > examples)
      out.push(`  … ${sec.findings.length - examples} more (use --all)`);
    out.push('');
  }
  return out.join('\n');
}
