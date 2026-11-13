import {
  CatalogPartSnapshot,
  CatalogSnapshot,
  FoundCandidate,
  findGmNumberCandidates,
  isEightDigitGm,
  listedNumbers,
  NotProposedShare,
  NumberLabel,
} from './oem-xref.catalog';
import {
  DIRECTIONAL_RELATIONS,
  XrefIssue,
  XrefRecord,
  XrefSide,
  XrefStatus,
} from './oem-xref.types';
import { GM_KEY, manufacturerKey } from './oem-xref.checks';
import { validateXrefDataset } from './oem-xref.validate';

/**
 * The OEM cross-reference dry-run planner. Pure and read-only: it takes a
 * dataset and a catalog snapshot and returns what a SEPARATE, separately
 * approved import would have to do. It never writes, never touches fitment and
 * never changes a status — a CANDIDATE stays a CANDIDATE whatever it carries.
 */

export interface SideMatch {
  found: boolean;
  title: string | null;
  partBrandName: string | null;
  /** How the listing labels this number; null when it does not carry it. */
  label: NumberLabel | null;
  asStored: string[];
}

export interface PlannedRecord {
  record: XrefRecord;
  from: SideMatch;
  to: SideMatch;
  issues: XrefIssue[];
  /** No error of any kind: a separate import could take it as is. */
  importable: boolean;
}

export interface CoveredCandidate {
  candidate: FoundCandidate;
  recordId: string;
  status: XrefStatus;
}

export interface XrefPlan {
  dataset: { name: string; label: string };
  snapshot: { capturedAt: string; database: string | null; parts: number };
  /** Every issue, dataset-level and per record. */
  issues: XrefIssue[];
  verified: PlannedRecord[];
  candidates: PlannedRecord[];
  rejected: PlannedRecord[];
  /** Finder pairs no record covers: new work for a reviewer. */
  newCandidates: FoundCandidate[];
  /** Finder pairs a CANDIDATE or VERIFIED record already covers. */
  knownCandidates: CoveredCandidate[];
  /** Finder pairs a REJECTED record covers: not proposed again. */
  suppressedCandidates: CoveredCandidate[];
  candidateGroups: Map<string, string[]>;
  notProposed: NotProposedShare[];
  /** Records without sufficient provenance, with why. */
  withoutProvenance: { recordId: string; status: XrefStatus; why: string }[];
  /** What a separate import would create, by record id. Nothing is run here. */
  pendingImport: {
    verified: string[];
    rejected: string[];
    candidates: string[];
  };
  /**
   * What this run writes: nothing. Fitment is not derived from a
   * cross-reference at all, so there is no fitment line to plan.
   */
  writes: { crossReferences: 0; fitment: 0; parts: 0 };
}

const sideKey = (s: XrefSide) =>
  `${s.catalogPartId}#${manufacturerKey(s.manufacturer)}:${s.normalized}`;
const numberKey = (s: XrefSide) =>
  `${manufacturerKey(s.manufacturer)}:${s.normalized}`;
const partPair = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const sidePair = (r: XrefRecord) => {
  const [x, y] = [sideKey(r.from), sideKey(r.to)].sort();
  return `${x}~${y}`;
};

function issue(
  recordId: string,
  category: XrefIssue['category'],
  code: string,
  message: string,
  severity: XrefIssue['severity'] = 'error',
): XrefIssue {
  return { recordId, category, severity, code, message };
}

function matchSide(
  r: XrefRecord,
  which: 'from' | 'to',
  parts: Map<string, CatalogPartSnapshot>,
  out: XrefIssue[],
): SideMatch {
  const side = r[which];
  const part = parts.get(side.catalogPartId);
  if (!part) {
    out.push(
      issue(
        r.id,
        'catalog',
        'part_not_in_catalog',
        `${which}: catalog part "${side.catalogPartId}" is not in the snapshot`,
      ),
    );
    return {
      found: false,
      title: null,
      partBrandName: null,
      label: null,
      asStored: [],
    };
  }
  const listed = listedNumbers(part).get(side.normalized);
  const match: SideMatch = {
    found: true,
    title: part.title,
    partBrandName: part.partBrandName,
    label: listed?.label ?? null,
    asStored: listed?.asStored ?? [],
  };
  if (!listed) {
    const has = [...listedNumbers(part).values()].map(
      (n) => `${n.canonical} (${n.label})`,
    );
    out.push(
      issue(
        r.id,
        'conflict',
        'number_not_on_listing',
        `${which}: listing "${part.id}" does not carry ${side.partNumber}; it carries ${has.join(', ') || 'no number'}`,
      ),
    );
    return match;
  }
  const isGm = manufacturerKey(side.manufacturer) === GM_KEY;
  if (!isGm && listed.label === 'GM')
    out.push(
      issue(
        r.id,
        'conflict',
        'issuer_label_conflict',
        `${which}: the record calls ${side.partNumber} a ${side.manufacturer} number, but listing "${part.id}" labels it GM`,
      ),
    );
  if (isGm && listed.label === 'OEM')
    out.push(
      issue(
        r.id,
        'conflict',
        'issuer_label_differs',
        `${which}: the record calls ${side.partNumber} a GM number; listing "${part.id}" labels it OEM`,
        'warning',
      ),
    );
  return match;
}

/** SAME_GM_NUMBER must still hold in this snapshot, or the basis is stale. */
function basisIssues(p: PlannedRecord): XrefIssue[] {
  const { record: r } = p;
  if (r.basis !== 'SAME_GM_NUMBER') return [];
  const holds =
    manufacturerKey(r.from.manufacturer) === GM_KEY &&
    manufacturerKey(r.to.manufacturer) === GM_KEY &&
    r.from.normalized === r.to.normalized &&
    isEightDigitGm(r.from.normalized) &&
    p.from.label === 'GM' &&
    p.to.label === 'GM';
  return holds
    ? []
    : [
        issue(
          r.id,
          'catalog',
          'basis_not_reproduced',
          'basis SAME_GM_NUMBER does not hold in this snapshot (both listings must carry the same 8-digit number labelled GM)',
          'warning',
        ),
      ];
}

function crossRecordIssues(records: XrefRecord[]): XrefIssue[] {
  const out: XrefIssue[] = [];

  // 1. The same claim twice, in either order for a symmetric relation.
  const claims = new Map<string, XrefRecord[]>();
  for (const r of records) {
    const rel = r.relation ?? 'ANY';
    const key =
      r.relation && DIRECTIONAL_RELATIONS.has(r.relation)
        ? `${r.status}|${rel}|${sideKey(r.from)}>${sideKey(r.to)}`
        : `${r.status}|${rel}|${sidePair(r)}`;
    claims.set(key, [...(claims.get(key) ?? []), r]);
  }
  for (const group of claims.values()) {
    if (group.length < 2) continue;
    const [first, ...rest] = group;
    for (const r of rest) {
      const reversed = sideKey(r.from) !== sideKey(first.from);
      out.push(
        issue(
          r.id,
          'duplicate',
          reversed ? 'duplicate_reversed' : 'duplicate',
          `repeats "${first.id}"${reversed ? ' with from and to swapped' : ''}: one claim, one record`,
        ),
      );
    }
  }

  // 2. Decided both ways, or still open although decided.
  const byPair = new Map<string, XrefRecord[]>();
  for (const r of records)
    byPair.set(sidePair(r), [...(byPair.get(sidePair(r)) ?? []), r]);
  for (const group of byPair.values()) {
    for (const v of group.filter((r) => r.status === 'VERIFIED')) {
      // A rejection contradicts the verified claim only when it refuses the
      // same claim: any relation at all (null), or the same relation — and for
      // a directional one, in the same direction. Refusing B→A says nothing
      // about A→B.
      const sameDirection = (r: XrefRecord) =>
        !DIRECTIONAL_RELATIONS.has(v.relation!) ||
        (sideKey(r.from) === sideKey(v.from) &&
          sideKey(r.to) === sideKey(v.to));
      for (const x of group.filter(
        (r) =>
          r.status === 'REJECTED' &&
          (r.relation === null ||
            (r.relation === v.relation && sameDirection(r))),
      ))
        for (const id of [v.id, x.id])
          out.push(
            issue(
              id,
              'conflict',
              'verified_and_rejected',
              `"${v.id}" verifies ${v.relation} for this pair, "${x.id}" rejects ${x.relation ?? 'any relation'}: the sources contradict each other — resolve before any import`,
            ),
          );
    }
    const decided = group.filter((r) => r.status !== 'CANDIDATE');
    for (const c of group.filter((r) => r.status === 'CANDIDATE'))
      if (decided.length)
        out.push(
          issue(
            c.id,
            'duplicate',
            'candidate_already_decided',
            `already decided by ${decided.map((d) => `"${d.id}" (${d.status})`).join(', ')}`,
            'warning',
          ),
        );
  }

  // 3. Supersession: a cycle is impossible; two successors need a look.
  const edges = new Map<string, { to: string; id: string }[]>();
  for (const r of records)
    if (r.status === 'VERIFIED' && r.relation === 'SUPERSEDED_BY')
      edges.set(numberKey(r.from), [
        ...(edges.get(numberKey(r.from)) ?? []),
        { to: numberKey(r.to), id: r.id },
      ]);
  const reaches = (start: string, goal: string): boolean => {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length) {
      const n = stack.pop()!;
      if (n === goal) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const e of edges.get(n) ?? []) stack.push(e.to);
    }
    return false;
  };
  for (const [from, list] of edges) {
    for (const e of list)
      if (reaches(e.to, from))
        out.push(
          issue(
            e.id,
            'conflict',
            'supersession_cycle',
            `${from} → ${e.to} closes a supersession cycle: a number cannot (indirectly) supersede itself`,
          ),
        );
    const successors = new Set(list.map((e) => e.to));
    if (successors.size > 1)
      for (const e of list)
        out.push(
          issue(
            e.id,
            'conflict',
            'superseded_twice',
            `${from} is superseded by ${[...successors].join(' and ')}: check whether the sources describe a split or contradict each other`,
            'warning',
          ),
        );
  }
  return out;
}

export function planOemCrossReference(
  rawDataset: unknown,
  snapshot: CatalogSnapshot,
  opts: { datasetName: string; today: Date },
): XrefPlan {
  const { records, issues: validation } = validateXrefDataset(rawDataset, {
    expectedName: opts.datasetName,
    today: opts.today,
  });
  const parts = new Map(snapshot.parts.map((p) => [p.id, p]));
  const issues: XrefIssue[] = [...validation];

  const planned = records.map((record): PlannedRecord => {
    const own: XrefIssue[] = [];
    const from = matchSide(record, 'from', parts, own);
    const to = matchSide(record, 'to', parts, own);
    const p: PlannedRecord = {
      record,
      from,
      to,
      issues: own,
      importable: false,
    };
    own.push(...basisIssues(p));
    return p;
  });
  const cross = crossRecordIssues(records);
  for (const p of planned) {
    p.issues.unshift(...validation.filter((i) => i.recordId === p.record.id));
    p.issues.push(...cross.filter((i) => i.recordId === p.record.id));
    p.importable = !p.issues.some((i) => i.severity === 'error');
  }
  for (const p of planned)
    issues.push(...p.issues.filter((i) => !validation.includes(i)));

  // Finder pairs against the dataset: coverage is by the PAIR OF LISTINGS.
  const search = findGmNumberCandidates(snapshot.parts);
  const byListings = new Map<string, PlannedRecord[]>();
  for (const p of planned) {
    const key = partPair(
      p.record.from.catalogPartId,
      p.record.to.catalogPartId,
    );
    byListings.set(key, [...(byListings.get(key) ?? []), p]);
  }
  const newCandidates: FoundCandidate[] = [];
  const knownCandidates: CoveredCandidate[] = [];
  const suppressedCandidates: CoveredCandidate[] = [];
  for (const candidate of search.candidates) {
    const covering =
      byListings.get(
        partPair(candidate.a.catalogPartId, candidate.b.catalogPartId),
      ) ?? [];
    // Only a sound rejection keeps a pair from coming back.
    const rejection = covering.find(
      (p) => p.record.status === 'REJECTED' && p.importable,
    );
    const open = covering.find((p) => p.record.status !== 'REJECTED');
    if (rejection)
      suppressedCandidates.push({
        candidate,
        recordId: rejection.record.id,
        status: 'REJECTED',
      });
    else if (open)
      knownCandidates.push({
        candidate,
        recordId: open.record.id,
        status: open.record.status,
      });
    else newCandidates.push(candidate);
  }

  const withoutProvenance = planned.flatMap((p) => {
    const r = p.record;
    const provenance = p.issues.filter(
      (i) => i.category === 'provenance' && i.severity === 'error',
    );
    if (provenance.length)
      return [
        {
          recordId: r.id,
          status: r.status,
          why: provenance.map((i) => i.code).join(', '),
        },
      ];
    if (r.evidence.length === 0 && r.status !== 'REJECTED')
      return [{ recordId: r.id, status: r.status, why: 'no source cited' }];
    return [];
  });

  const of = (s: XrefStatus) => planned.filter((p) => p.record.status === s);
  const importable = (s: XrefStatus) =>
    of(s)
      .filter((p) => p.importable)
      .map((p) => p.record.id);
  const ds = rawDataset as { name?: unknown; label?: unknown } | null;
  return {
    dataset: {
      name: opts.datasetName,
      label: typeof ds?.label === 'string' ? ds.label : opts.datasetName,
    },
    snapshot: {
      capturedAt: snapshot.capturedAt,
      database: snapshot.database,
      parts: snapshot.parts.length,
    },
    issues,
    verified: of('VERIFIED'),
    candidates: of('CANDIDATE'),
    rejected: of('REJECTED'),
    newCandidates,
    knownCandidates,
    suppressedCandidates,
    candidateGroups: search.groups,
    notProposed: search.notProposed,
    withoutProvenance,
    pendingImport: {
      verified: importable('VERIFIED'),
      rejected: importable('REJECTED'),
      candidates: importable('CANDIDATE'),
    },
    writes: { crossReferences: 0, fitment: 0, parts: 0 },
  };
}

/** Blocked: any error, dataset-level or in a record. */
export const isXrefPlanBlocked = (plan: XrefPlan): boolean =>
  plan.issues.some((i) => i.severity === 'error');
