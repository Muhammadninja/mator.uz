import { normalizeOem } from '../../common/normalize-oem.util';

/**
 * The catalog side of the OEM cross-reference dry-run: the snapshot that
 * `scripts/sql/oem-cross-reference-snapshot.sql` prints, how each listing's
 * numbers are labelled, and the candidate finder. Pure: no I/O.
 *
 * Labels come from the projection rule (catalog-projection.service.ts and the
 * schema comment on CatalogPart.gmNumbers): a number the seller labelled GM is
 * stored in gm_numbers only, one labelled OEM in oem_numbers only, and an
 * unlabelled number in BOTH. The canonical form (normalizeOem) decides which
 * array a number is in; the arrays also hold the number as written, which the
 * report shows. So:
 *   gm only  → GM          (issuer: GM)
 *   oem only → OEM         (issuer not recorded)
 *   both     → UNLABELLED  (issuer not recorded)
 * A Driver's Village position labels its gm_number column GM; its code_1c is
 * indexed under oem_numbers and names no issuer.
 */

export const SNAPSHOT_KIND = 'oem-xref-catalog';
export const SNAPSHOT_FORMAT_VERSION = 1;

export class XrefSnapshotFormatError extends Error {
  override readonly name = 'XrefSnapshotFormatError';
}

export type NumberLabel = 'GM' | 'OEM' | 'UNLABELLED';

export interface CatalogPartSnapshot {
  id: string;
  title: string;
  partBrandName: string | null;
  partNumberType: 'GM' | 'OEM' | 'UNKNOWN';
  gmNumbers: string[];
  oemNumbers: string[];
}

export interface CatalogSnapshot {
  capturedAt: string;
  database: string | null;
  parts: CatalogPartSnapshot[];
}

export interface ListedNumber {
  /** normalizeOem form; leading zeros kept. */
  canonical: string;
  label: NumberLabel;
  /** Every stored spelling of it on the listing, as stored. */
  asStored: string[];
}

type Row = Record<string, unknown>;
const fail = (msg: string): never => {
  throw new XrefSnapshotFormatError(msg);
};

function text(row: Row, key: string, where: string, max: number): string {
  const v = row[key];
  return typeof v === 'string' && v.length <= max
    ? v
    : fail(`${where}: "${key}" must be text of at most ${max} characters`);
}

/** Numbers must arrive as JSON strings: a JSON number would lose leading zeros. */
function numberList(row: Row, key: string, where: string): string[] {
  const v = row[key];
  if (!Array.isArray(v)) return fail(`${where}: "${key}" must be an array`);
  return v.map((n, i) =>
    typeof n === 'string' && n.length > 0 && n.length <= 100
      ? n
      : fail(
          `${where}: ${key}[${i}] must be non-empty text (a JSON number would drop leading zeros)`,
        ),
  );
}

/**
 * Parse the snapshot JSON. It crosses a trust boundary (pasted from a
 * terminal), so every field is checked; a vehicle-reference snapshot or any
 * other document is refused by its `kind`.
 */
export function parseCatalogSnapshot(raw: string): CatalogSnapshot {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    fail('the snapshot is not valid JSON');
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc))
    fail('the snapshot must be one JSON object');
  const d = doc as Row;
  if (d.kind !== SNAPSHOT_KIND)
    fail(
      `the snapshot kind is "${String(d.kind)}", expected "${SNAPSHOT_KIND}" (scripts/sql/oem-cross-reference-snapshot.sql)`,
    );
  if (d.format_version !== SNAPSHOT_FORMAT_VERSION)
    fail(
      `snapshot format_version ${String(d.format_version)} is not supported (expected ${SNAPSHOT_FORMAT_VERSION})`,
    );
  const capturedAt =
    typeof d.captured_at === 'string' &&
    !Number.isNaN(Date.parse(d.captured_at))
      ? d.captured_at
      : fail('"captured_at" must be a timestamp');
  const database =
    d.database === undefined || d.database === null
      ? null
      : typeof d.database === 'string'
        ? d.database
        : fail('"database" must be text');
  if (!Array.isArray(d.parts)) fail('"parts" must be an array');
  const seen = new Set<string>();
  const parts = (d.parts as unknown[]).map((r, i): CatalogPartSnapshot => {
    const where = `parts[${i}]`;
    if (!r || typeof r !== 'object' || Array.isArray(r))
      fail(`${where} must be an object`);
    const row = r as Row;
    const id = text(row, 'id', where, 64);
    if (!id) fail(`${where}: "id" is empty`);
    if (seen.has(id)) fail(`${where}: part id "${id}" appears twice`);
    seen.add(id);
    const type = row.part_number_type;
    if (type !== 'GM' && type !== 'OEM' && type !== 'UNKNOWN')
      fail(`${where}: "part_number_type" must be GM, OEM or UNKNOWN`);
    return {
      id,
      title: text(row, 'title', where, 255),
      partBrandName:
        row.part_brand_name === null
          ? null
          : text(row, 'part_brand_name', where, 120),
      partNumberType: type as CatalogPartSnapshot['partNumberType'],
      gmNumbers: numberList(row, 'gm_numbers', where),
      oemNumbers: numberList(row, 'oem_numbers', where),
    };
  });
  return { capturedAt, database, parts };
}

/** The numbers a listing carries, by canonical form, with their label. */
export function listedNumbers(
  part: CatalogPartSnapshot,
): Map<string, ListedNumber> {
  const out = new Map<string, ListedNumber>();
  const add = (stored: string, inGm: boolean) => {
    const canonical = normalizeOem(stored);
    if (!canonical) return;
    const entry = out.get(canonical) ?? {
      canonical,
      label: inGm ? 'GM' : 'OEM',
      asStored: [],
    };
    if (entry.label === 'GM' && !inGm) entry.label = 'UNLABELLED';
    if (entry.label === 'OEM' && inGm) entry.label = 'UNLABELLED';
    if (!entry.asStored.includes(stored)) entry.asStored.push(stored);
    out.set(canonical, entry);
  };
  part.gmNumbers.forEach((n) => add(n, true));
  part.oemNumbers.forEach((n) => add(n, false));
  // A display form and its canonical form are one number: drop the canonical
  // spelling from asStored when a written spelling exists.
  for (const entry of out.values()) {
    if (entry.asStored.length > 1)
      entry.asStored = entry.asStored.filter((s) => s !== entry.canonical);
  }
  return out;
}

/** An exact 8-digit GM number. Compared as a string: `09593992` ≠ `9593992`. */
export const isEightDigitGm = (canonical: string): boolean =>
  /^[0-9]{8}$/.test(canonical);

export interface CandidatePartRef {
  catalogPartId: string;
  title: string;
  partBrandName: string | null;
  /** The number as the listing stores it. */
  asStored: string[];
}

/** A pair the finder proposes. Always CANDIDATE, never a relation. */
export interface FoundCandidate {
  /** `SAME_GM_NUMBER:<number>:<partA>|<partB>`, parts in id order. */
  key: string;
  status: 'CANDIDATE';
  relation: null;
  basis: 'SAME_GM_NUMBER';
  /** The exact shared number (canonical form). */
  number: string;
  a: CandidatePartRef;
  b: CandidatePartRef;
}

/** A number shared by several listings that the finder does NOT propose. */
export interface NotProposedShare {
  number: string;
  reason: 'issuer_not_recorded' | 'gm_but_not_8_digits';
  parts: { catalogPartId: string; label: NumberLabel }[];
}

export interface CandidateSearch {
  candidates: FoundCandidate[];
  /** Numbers behind the candidates: number → listings carrying it as GM. */
  groups: Map<string, string[]>;
  notProposed: NotProposedShare[];
}

/**
 * Pairs of DIFFERENT listings that both carry the same exact 8-digit number
 * labelled GM. Exact canonical equality only: no prefix, no fuzzy distance, no
 * title / category / brand similarity, nothing across manufacturers. A shared
 * number whose issuer is not recorded on every listing (OEM-labelled or
 * unlabelled), or a GM number that is not 8 digits, is listed as not proposed.
 * Deterministic: sorted by number, then part ids.
 */
export function findGmNumberCandidates(
  parts: readonly CatalogPartSnapshot[],
): CandidateSearch {
  const holders = new Map<
    string,
    { part: CatalogPartSnapshot; listed: ListedNumber }[]
  >();
  for (const part of parts) {
    for (const listed of listedNumbers(part).values()) {
      const list = holders.get(listed.canonical) ?? [];
      list.push({ part, listed });
      holders.set(listed.canonical, list);
    }
  }

  const ref = (h: {
    part: CatalogPartSnapshot;
    listed: ListedNumber;
  }): CandidatePartRef => ({
    catalogPartId: h.part.id,
    title: h.part.title,
    partBrandName: h.part.partBrandName,
    asStored: h.listed.asStored,
  });

  const candidates: FoundCandidate[] = [];
  const groups = new Map<string, string[]>();
  const notProposed: NotProposedShare[] = [];
  for (const number of [...holders.keys()].sort()) {
    const list = holders
      .get(number)!
      .sort((x, y) => (x.part.id < y.part.id ? -1 : 1));
    if (list.length < 2) continue;
    const allGm = list.every((h) => h.listed.label === 'GM');
    if (!allGm || !isEightDigitGm(number)) {
      notProposed.push({
        number,
        reason: allGm ? 'gm_but_not_8_digits' : 'issuer_not_recorded',
        parts: list.map((h) => ({
          catalogPartId: h.part.id,
          label: h.listed.label,
        })),
      });
    }
    // Only the GM-labelled holders of an 8-digit number pair up.
    const gm = isEightDigitGm(number)
      ? list.filter((h) => h.listed.label === 'GM')
      : [];
    if (gm.length < 2) continue;
    groups.set(
      number,
      gm.map((h) => h.part.id),
    );
    for (let i = 0; i < gm.length; i += 1) {
      for (let j = i + 1; j < gm.length; j += 1) {
        candidates.push({
          key: `SAME_GM_NUMBER:${number}:${gm[i].part.id}|${gm[j].part.id}`,
          status: 'CANDIDATE',
          relation: null,
          basis: 'SAME_GM_NUMBER',
          number,
          a: ref(gm[i]),
          b: ref(gm[j]),
        });
      }
    }
  }
  return { candidates, groups, notProposed };
}
