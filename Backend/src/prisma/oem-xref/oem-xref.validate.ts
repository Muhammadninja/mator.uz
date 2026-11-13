import { normalizeOem } from '../../common/normalize-oem.util';
import {
  Collector,
  GM_KEY,
  isObj,
  isoDateErrors,
  manufacturerKey,
  show,
  str,
  strictKeys,
} from './oem-xref.checks';
import { validateEvidence } from './oem-xref.evidence';
import {
  CANDIDATE_BASES,
  OEM_XREF_FORMAT_VERSION,
  REJECTION_REASONS,
  XREF_RELATIONS,
  XREF_STATUSES,
  XrefEvidence,
  XrefIssue,
  XrefRecord,
} from './oem-xref.types';

/**
 * Structural and provenance validation of an OEM cross-reference dataset. Pure.
 * The input is `unknown` on purpose: a dataset may one day arrive as a JSON
 * file, so nothing is trusted because TypeScript typed it.
 *
 * A record with a structure error is excluded from every later check (the
 * planner never sees it). Provenance errors keep the record visible to the
 * planner (duplicates, conflicts) but block it from any import.
 */

export { GM_KEY, manufacturerKey } from './oem-xref.checks';

/** Latin letters and digits, split by single `space . - /`, as indexOem accepts. */
const PART_NUMBER = /^[A-Za-z0-9]+(?:[ .\-/][A-Za-z0-9]+)*$/;
const RECORD_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;

const SIDE_KEYS = ['catalogPartId', 'manufacturer', 'partNumber', 'normalized'];
const REJECTION_KEYS = ['reason', 'detail', 'reviewedBy', 'reviewedOn'];
const RECORD_KEYS = [
  'id',
  'status',
  'relation',
  'from',
  'to',
  'basis',
  'evidence',
  'rejection',
  'note',
];

export interface ValidatedDataset {
  /** Records with no structure error, in dataset order. */
  records: XrefRecord[];
  issues: XrefIssue[];
}

function validateSide(c: Collector, v: unknown, where: string): void {
  if (!isObj(v))
    return c.add('structure', 'bad_side', `${where} must be an object`);
  strictKeys(c, v, SIDE_KEYS, where);
  if (!str(v.catalogPartId, 64))
    c.add(
      'structure',
      'bad_part_id',
      `${where}.catalogPartId must be a catalog_parts id`,
    );
  const manufacturer = str(v.manufacturer, 120);
  if (!manufacturer || !manufacturerKey(manufacturer))
    c.add(
      'structure',
      'bad_manufacturer',
      `${where}.manufacturer must name the manufacturer whose numbering the number belongs to`,
    );
  const number = str(v.partNumber, 64);
  if (!number || !PART_NUMBER.test(number)) {
    c.add(
      'structure',
      'bad_part_number',
      `${where}.partNumber "${show(v.partNumber)}" must be Latin letters and digits split by single space . - / (normalizeOem would silently drop anything else)`,
    );
    return;
  }
  const canonical = normalizeOem(number);
  if (v.normalized !== canonical)
    c.add(
      'structure',
      'normalized_mismatch',
      `${where}.normalized "${show(v.normalized)}" is not normalizeOem("${number}") = "${canonical}"`,
    );
  if (canonical.length < 4 || !/[0-9]/.test(canonical))
    c.add(
      'structure',
      'number_too_weak',
      `${where}: "${number}" is shorter than 4 characters or has no digit — too weak to identify a part`,
    );
  if (
    manufacturer &&
    manufacturerKey(manufacturer) === GM_KEY &&
    !/^[0-9]+$/.test(canonical)
  )
    c.add(
      'structure',
      'gm_number_format',
      `${where}: a GM number has digits only, "${number}" does not`,
    );
}

function validateRecord(
  raw: unknown,
  index: number,
  today: Date,
): {
  record: XrefRecord | null;
  issues: XrefIssue[];
} {
  const id = isObj(raw) && typeof raw.id === 'string' ? raw.id : null;
  const c = new Collector(id ?? `records[${index}]`);
  if (!isObj(raw)) {
    c.add('structure', 'bad_record', `records[${index}] must be an object`);
    return { record: null, issues: c.issues };
  }
  strictKeys(c, raw, RECORD_KEYS, `record ${id ?? index}`);
  if (!id || !RECORD_ID.test(id))
    c.add(
      'structure',
      'bad_id',
      `records[${index}].id "${show(raw.id)}" must be lowercase letters, digits and dashes`,
    );
  const status = raw.status as string;
  if (!XREF_STATUSES.includes(status as never))
    c.add(
      'structure',
      'bad_status',
      `status "${show(status)}" is not one of ${XREF_STATUSES.join(', ')}`,
    );
  if (raw.relation !== null && !XREF_RELATIONS.includes(raw.relation as never))
    c.add(
      'structure',
      'bad_relation',
      `relation "${show(raw.relation)}" is not one of ${XREF_RELATIONS.join(', ')} or null`,
    );
  if (raw.basis !== null && !CANDIDATE_BASES.includes(raw.basis as never))
    c.add(
      'structure',
      'bad_basis',
      `basis "${show(raw.basis)}" is not one of ${CANDIDATE_BASES.join(', ')} or null`,
    );
  if (typeof raw.note !== 'string' || raw.note.length > 1000)
    c.add('structure', 'bad_note', 'note must be text (may be empty)');
  validateSide(c, raw.from, 'from');
  validateSide(c, raw.to, 'to');
  if (!Array.isArray(raw.evidence))
    c.add(
      'structure',
      'bad_evidence_list',
      'evidence must be an array (may be empty)',
    );

  if (c.structureFailed) return { record: null, issues: c.issues };

  const rec = raw as unknown as XrefRecord;
  const from = rec.from;
  const to = rec.to;
  const sameIdentity =
    manufacturerKey(from.manufacturer) === manufacturerKey(to.manufacturer) &&
    from.normalized === to.normalized;
  if (sameIdentity && from.catalogPartId === to.catalogPartId)
    c.add(
      'structure',
      'self_reference',
      'from and to are the same number on the same listing',
    );

  // Status rules.
  if (status === 'CANDIDATE' && rec.basis === null)
    c.add(
      'structure',
      'candidate_without_basis',
      'a CANDIDATE needs a basis (why the pair is proposed)',
    );
  if (status === 'REJECTED') {
    const r = rec.rejection as unknown;
    if (!isObj(r))
      c.add(
        'structure',
        'rejection_missing',
        'a REJECTED record must say why (rejection)',
      );
    else {
      strictKeys(c, r, REJECTION_KEYS, 'rejection');
      if (!REJECTION_REASONS.includes(r.reason as never))
        c.add(
          'structure',
          'bad_rejection_reason',
          `rejection.reason "${show(r.reason)}" is not one of ${REJECTION_REASONS.join(', ')}`,
        );
      if (!str(r.detail, 500))
        c.add(
          'structure',
          'bad_rejection_detail',
          'rejection.detail is required',
        );
      if (!str(r.reviewedBy, 80))
        c.add(
          'structure',
          'bad_rejection_reviewer',
          'rejection.reviewedBy is required',
        );
      const err = isoDateErrors(r.reviewedOn, today);
      if (err)
        c.add('structure', 'bad_rejection_date', `rejection.reviewedOn ${err}`);
    }
  } else if (rec.rejection !== null) {
    c.add(
      'structure',
      'rejection_on_open_record',
      `only a REJECTED record carries a rejection (this one is ${status})`,
    );
  }
  if (status === 'VERIFIED' && rec.relation === null)
    c.add(
      'structure',
      'verified_without_relation',
      'a VERIFIED record must state which relation is confirmed',
    );
  if (status === 'VERIFIED' && sameIdentity)
    c.add(
      'structure',
      'identical_numbers_not_verifiable',
      'from and to are the same number: a source cannot confirm a relation between a number and itself (two listings sharing one number stay a CANDIDATE or are REJECTED)',
    );
  if (rec.relation === 'SUPERSEDED_BY') {
    if (manufacturerKey(from.manufacturer) !== manufacturerKey(to.manufacturer))
      c.add(
        'structure',
        'supersession_across_manufacturers',
        "SUPERSEDED_BY is a number change inside ONE manufacturer's numbering",
      );
    if (from.normalized === to.normalized)
      c.add(
        'structure',
        'supersession_to_itself',
        'a number is not superseded by itself',
      );
  }
  if (c.structureFailed) return { record: null, issues: c.issues };

  // Provenance.
  rec.evidence.forEach((e, i) =>
    validateEvidence(c, e, `evidence[${i}]`, raw, today),
  );
  // Vehicle data inside a source drops the record like anywhere else.
  if (c.structureFailed) return { record: null, issues: c.issues };
  const asserted = new Set(
    rec.evidence.map((e) =>
      isObj(e) ? (e as XrefEvidence).asserts : undefined,
    ),
  );
  if (status === 'VERIFIED') {
    if (rec.evidence.length === 0)
      c.add(
        'provenance',
        'verified_without_source',
        'VERIFIED without any source: only an admissible source can confirm a cross-reference',
      );
    else if (!asserted.has(rec.relation!))
      c.add(
        'provenance',
        'no_source_for_relation',
        `no source asserts ${rec.relation}`,
      );
    const other = [...asserted].filter((a) => a && a !== rec.relation);
    if (other.length)
      c.add(
        'conflict',
        'contradicting_evidence',
        `the sources disagree: ${rec.relation} vs ${other.join(', ')}`,
      );
  }
  if (
    status === 'REJECTED' &&
    rec.relation !== null &&
    asserted.has(rec.relation)
  )
    c.add(
      'conflict',
      'contradicting_evidence',
      `rejected as ${rec.relation}, yet a cited source asserts ${rec.relation}`,
    );
  if (
    status === 'REJECTED' &&
    rec.relation === null &&
    [...asserted].some((a) => a && a !== 'NO_RELATION')
  )
    c.add(
      'conflict',
      'contradicting_evidence',
      'rejected as any relation, yet a cited source asserts one',
    );
  if (status === 'CANDIDATE' && rec.evidence.length > 0)
    c.add(
      'provenance',
      'candidate_not_promoted',
      "this CANDIDATE carries sources; it stays a CANDIDATE — promoting it to VERIFIED is a reviewer's edit, never automatic",
      'warning',
    );
  return { record: rec, issues: c.issues };
}

/**
 * Validate a dataset. `expectedName` is the registry key it was selected by;
 * a mismatch, a retired dataset or another format version refuses the whole
 * dataset (records: []), so a run cannot use an old or wrong file by accident.
 */
export function validateXrefDataset(
  raw: unknown,
  opts: { expectedName: string; today: Date },
): ValidatedDataset {
  const top = new Collector(null);
  if (!isObj(raw)) {
    top.add('structure', 'bad_dataset', 'the dataset must be an object');
    return { records: [], issues: top.issues };
  }
  strictKeys(
    top,
    raw,
    ['formatVersion', 'name', 'label', 'retired', 'records'],
    'dataset',
  );
  if (raw.formatVersion !== OEM_XREF_FORMAT_VERSION)
    top.add(
      'structure',
      'unsupported_format',
      `formatVersion ${show(raw.formatVersion)} is not supported (expected ${OEM_XREF_FORMAT_VERSION})`,
    );
  if (raw.name !== opts.expectedName)
    top.add(
      'structure',
      'dataset_name_mismatch',
      `the dataset calls itself "${show(raw.name)}", but "${opts.expectedName}" was requested`,
    );
  if (raw.retired !== false)
    top.add(
      'structure',
      'dataset_retired',
      'the dataset is retired (or does not say it is not) and cannot be run',
    );
  if (!Array.isArray(raw.records))
    top.add('structure', 'bad_records', '"records" must be an array');
  if (top.structureFailed) return { records: [], issues: top.issues };

  const issues = [...top.issues];
  const records: XrefRecord[] = [];
  const ids = new Map<string, number>();
  (raw.records as unknown[]).forEach((r, i) => {
    const result = validateRecord(r, i, opts.today);
    issues.push(...result.issues);
    if (!result.record) return;
    const seen = ids.get(result.record.id);
    if (seen !== undefined) {
      issues.push({
        recordId: result.record.id,
        category: 'duplicate',
        severity: 'error',
        code: 'duplicate_id',
        message: `record id "${result.record.id}" is used by records[${seen}] and records[${i}]`,
      });
      return;
    }
    ids.set(result.record.id, i);
    records.push(result.record);
  });
  return { records, issues };
}
