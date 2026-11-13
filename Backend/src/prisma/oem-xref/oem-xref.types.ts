/**
 * OEM cross-reference dataset format (Wave 4). Version 1.
 *
 * A cross-reference states how two PART NUMBERS relate, each number owned by
 * the manufacturer whose numbering it belongs to, and attaches the claim to the
 * catalog listings that carry those numbers. It is NOT vehicle fitment: nothing
 * here says which vehicles a part fits, and no record may carry vehicle data
 * (the validator refuses unknown fields). A verified cross-reference never
 * moves fitment, universality or a category from one listing to another.
 *
 * Three statuses, deliberately not a confidence score:
 *   CANDIDATE — a technical reason to look at the pair (basis), no proof.
 *   VERIFIED  — at least one admissible source states this exact relation
 *               between these exact numbers, with an exact locator.
 *   REJECTED  — reviewed and refused; the reason is kept so the candidate
 *               finder does not propose the pair again.
 * A status is only ever written by a reviewer editing the dataset. Nothing in
 * the pipeline promotes a CANDIDATE, whatever evidence it carries.
 */

export const OEM_XREF_FORMAT_VERSION = 1;

export const XREF_STATUSES = ['CANDIDATE', 'VERIFIED', 'REJECTED'] as const;
export type XrefStatus = (typeof XREF_STATUSES)[number];

/**
 * The relation between `from` and `to`. Each has one meaning:
 *   SAME_PART            the two numbers identify the same physical part
 *                        (e.g. a supplier's own article for the GM part it
 *                        makes, as the supplier's or GM's catalog lists it).
 *                        Symmetric.
 *   SUPERSEDED_BY        `from` was replaced by `to` in the SAME manufacturer's
 *                        numbering (an official number change). Directional:
 *                        `from` is the old number, `to` the new one.
 *   OFFICIAL_REPLACEMENT `to` is officially approved for use instead of `from`
 *                        (e.g. an aftermarket catalog listing its article for an
 *                        OEM number). Directional, one way: it says nothing
 *                        about using `from` instead of `to`.
 *   INTERCHANGEABLE      a source states each can be used instead of the other,
 *                        without claiming they are the same part. Symmetric.
 * "Possible match" is not a relation: it is the CANDIDATE status.
 */
export const XREF_RELATIONS = [
  'SAME_PART',
  'SUPERSEDED_BY',
  'OFFICIAL_REPLACEMENT',
  'INTERCHANGEABLE',
] as const;
export type XrefRelation = (typeof XREF_RELATIONS)[number];

export const DIRECTIONAL_RELATIONS: ReadonlySet<XrefRelation> = new Set([
  'SUPERSEDED_BY',
  'OFFICIAL_REPLACEMENT',
]);

/**
 * What a source may assert: one of the relations, or NO_RELATION (the source
 * shows the two numbers are different parts) — only a REJECTED record uses it.
 */
export type EvidenceAssertion = XrefRelation | 'NO_RELATION';
export const EVIDENCE_ASSERTIONS: readonly EvidenceAssertion[] = [
  ...XREF_RELATIONS,
  'NO_RELATION',
];

/**
 * Admissible sources. Anything else (a seller's listing, a forum, a price list,
 * an unlicensed catalog export, the demo CSV in prisma/data) is not evidence.
 *   MANUFACTURER_CATALOG  the official catalog of the manufacturer of one side.
 *   SUPERSESSION_BULLETIN an official number-change notice of the manufacturer;
 *                         supports SUPERSEDED_BY only.
 *   LICENSED_CATALOG      a third-party catalog Mator holds a licence for; the
 *                         licence reference is required.
 */
export const EVIDENCE_TYPES = [
  'MANUFACTURER_CATALOG',
  'SUPERSESSION_BULLETIN',
  'LICENSED_CATALOG',
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

/**
 * Why a pair was proposed. A basis is a reason to review, never proof.
 *   SAME_GM_NUMBER       both listings carry the same exact 8-digit number, and
 *                        each labels it GM (see oem-xref.catalog.ts).
 *   REVIEWER_SUGGESTION  a reviewer added the pair by hand (say why in `note`).
 */
export const CANDIDATE_BASES = [
  'SAME_GM_NUMBER',
  'REVIEWER_SUGGESTION',
] as const;
export type CandidateBasis = (typeof CANDIDATE_BASES)[number];

export const REJECTION_REASONS = [
  /** An admissible source shows the numbers are different parts. */
  'SOURCE_SHOWS_DIFFERENT_PARTS',
  /** Same family, different axle / side / position (front vs rear, left vs right). */
  'DIFFERENT_POSITION',
  /** Physical or technical parameters differ (dimensions, connector, rating). */
  'DIFFERENT_SPECIFICATION',
  /** A listing carries the number by mistake or under the wrong label. */
  'NUMBER_MISLABELLED_ON_LISTING',
  /** The claimed supersession / replacement is not in the cited source. */
  'NOT_IN_SOURCE',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

/** One side of a cross-reference: a number on a catalog listing. */
export interface XrefSide {
  /** catalog_parts.id of the listing that carries the number. */
  catalogPartId: string;
  /**
   * The manufacturer whose numbering `partNumber` belongs to — `GM` for
   * 96475028, `Hi-Q` for SP1362 — not necessarily who made the listed item.
   * Compared by manufacturerKey(); two manufacturers' numbers are never one.
   */
  manufacturer: string;
  /** The number exactly as the source prints it (separators kept). */
  partNumber: string;
  /** normalizeOem(partNumber); checked, never trusted. Leading zeros kept. */
  normalized: string;
}

export interface XrefEvidence {
  type: EvidenceType;
  /** Organisation that issued the document (a manufacturer for official types). */
  publisher: string;
  /** Catalog / bulletin identifier and edition, e.g. "GM EPC 2024-03". */
  documentId: string;
  /** https link to the document, when it has one. */
  url: string | null;
  /** Exact place inside the document: page, table, row, section. */
  locator: string;
  /** YYYY-MM-DD the source was read. */
  retrievedOn: string;
  /** Licence / agreement reference; required for LICENSED_CATALOG. */
  licence: string | null;
  /** The two numbers exactly as the source prints them, mapped to from/to. */
  cites: { from: string; to: string };
  /** What the source states about the pair. */
  asserts: EvidenceAssertion;
  /** What exactly this source confirms, in a sentence. */
  statement: string;
}

export interface XrefRejection {
  reason: RejectionReason;
  detail: string;
  /** Reviewer handle (not a customer). */
  reviewedBy: string;
  /** YYYY-MM-DD. */
  reviewedOn: string;
}

export interface XrefRecord {
  /** Stable id, lowercase: `xref-0001`. Never reused. */
  id: string;
  status: XrefStatus;
  /** VERIFIED: the confirmed relation. CANDIDATE: the proposed one, or null.
   *  REJECTED: the refused relation, or null = refused as any relation. */
  relation: XrefRelation | null;
  from: XrefSide;
  to: XrefSide;
  /** Required for CANDIDATE; kept as history on the other statuses. */
  basis: CandidateBasis | null;
  evidence: XrefEvidence[];
  /** Required for REJECTED, null otherwise. */
  rejection: XrefRejection | null;
  /** Free reviewer comment; may be empty. */
  note: string;
}

export interface XrefDataset {
  formatVersion: typeof OEM_XREF_FORMAT_VERSION;
  /** Must equal the key the dataset is registered under. */
  name: string;
  label: string;
  /** A retired dataset is kept for the record and refused by the CLI. */
  retired: boolean;
  records: XrefRecord[];
}

/** One problem found by the validator or the planner. */
export interface XrefIssue {
  recordId: string | null;
  /**
   *   structure   — malformed record (excluded from every later check)
   *   provenance  — evidence missing, incomplete or inadmissible
   *   duplicate   — the same claim twice (also in reverse order)
   *   conflict    — contradicts another record, or the catalog's own numbers
   *   catalog     — a side cannot be matched to a catalog listing
   */
  category: 'structure' | 'provenance' | 'duplicate' | 'conflict' | 'catalog';
  severity: 'error' | 'warning';
  code: string;
  message: string;
}
