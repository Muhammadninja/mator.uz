import type { FoundCandidate } from './oem-xref.catalog';
import type { PlannedRecord, XrefPlan } from './oem-xref.plan';
import { isXrefPlanBlocked } from './oem-xref.plan';
import type { XrefIssue } from './oem-xref.types';

/**
 * Plain-text dry-run report for a reviewer. Every section the Wave 4 brief
 * asks for is always printed, empty or not, so a missing section is never
 * mistaken for "nothing to report". Lists are capped; counts are not.
 */

const CAP = 50;

const capped = <T>(list: T[], line: (t: T) => string): string[] => [
  ...list.slice(0, CAP).map(line),
  ...(list.length > CAP ? [`  … and ${list.length - CAP} more`] : []),
];

const brand = (b: string | null) => b ?? 'brand not set';

function candidateLine(c: FoundCandidate): string {
  return [
    `  GM ${c.number} (exact 8-digit number, labelled GM on both listings)`,
    `    a: ${c.a.catalogPartId} — ${c.a.title} [${brand(c.a.partBrandName)}] stored as ${c.a.asStored.join(' / ')}`,
    `    b: ${c.b.catalogPartId} — ${c.b.title} [${brand(c.b.partBrandName)}] stored as ${c.b.asStored.join(' / ')}`,
  ].join('\n');
}

function recordLine(p: PlannedRecord): string {
  const r = p.record;
  const side = (w: 'from' | 'to') => {
    const s = r[w];
    const m = p[w];
    const where = m.found
      ? `${s.catalogPartId} — ${m.title} [${brand(m.partBrandName)}], listing labels it ${m.label ?? 'NOT CARRIED'}`
      : `${s.catalogPartId} — NOT IN CATALOG`;
    return `    ${w}: ${s.manufacturer} ${s.partNumber} (${s.normalized}) on ${where}`;
  };
  const sources = r.evidence.map(
    (e) =>
      `    source: ${e.type} ${e.publisher}, ${e.documentId}, ${e.locator}, read ${e.retrievedOn}${e.url ? `, ${e.url}` : ''} — asserts ${e.asserts}: ${e.statement}`,
  );
  return [
    `  ${r.id} ${r.status} ${r.relation ?? '(no relation)'}${p.importable ? '' : ' — BLOCKED'}`,
    side('from'),
    side('to'),
    ...sources,
    ...(r.rejection
      ? [
          `    rejected: ${r.rejection.reason} by ${r.rejection.reviewedBy} on ${r.rejection.reviewedOn}: ${r.rejection.detail}`,
        ]
      : []),
  ].join('\n');
}

const issueLine = (i: XrefIssue) =>
  `  [${i.severity}] ${i.recordId ?? 'dataset'} ${i.code}: ${i.message}`;

export function formatXrefReport(plan: XrefPlan, target: string): string {
  const by = (category: XrefIssue['category']) =>
    plan.issues.filter((i) => i.category === category);
  const section = (title: string, lines: string[]) => [
    '',
    `${title}`,
    ...(lines.length ? lines : ['  (none)']),
  ];
  const blocked = isXrefPlanBlocked(plan);
  return [
    `OEM cross-reference DRY-RUN — dataset "${plan.dataset.name}" (${plan.dataset.label})`,
    `Catalog: ${target}; ${plan.snapshot.parts} catalog parts, captured ${plan.snapshot.capturedAt}.`,
    'Nothing is written: no database connection is made, and no cross-reference, fitment or part row changes.',
    'A cross-reference is never vehicle fitment: no candidate or verified pair moves compatibility between listings.',
    `Result: ${blocked ? 'BLOCKED (errors below)' : 'no errors'}.`,
    ...section(
      `1. New candidates (${plan.newCandidates.length} pairs over ${plan.candidateGroups.size} GM numbers; review needed — NOT compatible, NOT shown to buyers)`,
      capped(plan.newCandidates, candidateLine),
    ),
    ...section(
      `   Candidates already in the dataset (${plan.knownCandidates.length})`,
      capped(
        plan.knownCandidates,
        (k) =>
          `  GM ${k.candidate.number} ${k.candidate.a.catalogPartId} | ${k.candidate.b.catalogPartId} → ${k.recordId} (${k.status})`,
      ),
    ),
    ...section(
      `   Not proposed again: rejected earlier (${plan.suppressedCandidates.length})`,
      capped(
        plan.suppressedCandidates,
        (k) =>
          `  GM ${k.candidate.number} ${k.candidate.a.catalogPartId} | ${k.candidate.b.catalogPartId} → ${k.recordId}`,
      ),
    ),
    ...section(
      `   Shared numbers NOT proposed (${plan.notProposed.length}): issuer not recorded, or not an 8-digit GM number`,
      capped(
        plan.notProposed,
        (n) =>
          `  ${n.number} (${n.reason}): ${n.parts.map((p) => `${p.catalogPartId} ${p.label}`).join(', ')}`,
      ),
    ),
    ...section(
      `2. Verified cross-references (${plan.verified.length})`,
      plan.verified.map(recordLine),
    ),
    ...section(
      `   Dataset candidates (${plan.candidates.length})`,
      plan.candidates.map(recordLine),
    ),
    ...section(
      `3. Rejected records (${plan.rejected.length})`,
      plan.rejected.map(recordLine),
    ),
    ...section(
      `4. Duplicates (${by('duplicate').length})`,
      by('duplicate').map(issueLine),
    ),
    ...section(
      `5. Conflicts (${by('conflict').length})`,
      by('conflict').map(issueLine),
    ),
    ...section(
      `6. Records without sufficient provenance (${plan.withoutProvenance.length})`,
      plan.withoutProvenance.map(
        (w) => `  ${w.recordId} (${w.status}): ${w.why}`,
      ),
    ),
    ...section(
      `   Provenance issues (${by('provenance').length})`,
      by('provenance').map(issueLine),
    ),
    ...section(
      `7. Not matched to the catalog (${by('catalog').length})`,
      by('catalog').map(issueLine),
    ),
    ...section(
      `   Structure errors (${by('structure').length})`,
      by('structure').map(issueLine),
    ),
    ...section(
      '8. Changes a SEPARATE, separately approved import would need (not run; no table exists yet — see docs/OEM_CROSS_REFERENCE_SCHEMA_PROPOSAL.md)',
      [
        `  cross-references to store as VERIFIED: ${plan.pendingImport.verified.length}${plan.pendingImport.verified.length ? ` (${plan.pendingImport.verified.join(', ')})` : ''}`,
        `  rejections to store: ${plan.pendingImport.rejected.length}`,
        `  candidates to queue for review: ${plan.pendingImport.candidates.length + plan.newCandidates.length}`,
        '  fitment rows: 0 (never derived from a cross-reference)',
        '  catalog part changes: 0 (numbers, universality and categories are left as they are)',
      ],
    ),
  ].join('\n');
}
