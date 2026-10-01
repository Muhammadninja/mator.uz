/**
 * Validation and ordering for the explicit business TOP-300 list
 * (fitment-top300.list.ts). Pure functions — no database — shared by the
 * queue service, the `fitment:top300` dry-run script and the tests.
 */

/** The intended size of the first-release list. Informational: a shorter list
 *  is valid (it is filled incrementally) and is never padded with other parts. */
export const TOP300_TARGET_SIZE = 300;

/** DI token for the list the queue uses (tests inject their own). */
export const FITMENT_TOP300_LIST = Symbol('FITMENT_TOP300_LIST');

/** CatalogPart.id is VarChar(64); ids never contain whitespace. */
const ID_PATTERN = /^\S{1,64}$/;

/**
 *  resolved  — valid, and present in the supplied set of known part ids
 *  unknown   — valid, but NOT among the known part ids
 *  unchecked — valid; no known-id set was supplied to check against
 *  duplicate — already listed at an earlier position (that one wins)
 *  invalid   — not a usable CatalogPart id (blank, whitespace, too long, not a string)
 */
export type Top300Status =
  'resolved' | 'unknown' | 'unchecked' | 'duplicate' | 'invalid';

export interface Top300Entry {
  /** 1-based position in the list as written. */
  position: number;
  identifier: string;
  status: Top300Status;
  /** For a duplicate: the position of the occurrence that counts. */
  firstPosition?: number;
}

export interface Top300Report {
  entries: Top300Entry[];
  /** Valid ids, first occurrence only, in list order — what the queue uses. */
  ids: string[];
  duplicates: Top300Entry[];
  invalid: Top300Entry[];
  unknown: Top300Entry[];
  targetSize: number;
  /** True when the list holds exactly TOP300_TARGET_SIZE usable ids. */
  isComplete: boolean;
}

export function validateTop300List(
  raw: readonly unknown[],
  known?: ReadonlySet<string>,
): Top300Report {
  const firstSeen = new Map<string, number>();
  const entries: Top300Entry[] = raw.map((value, i) => {
    const position = i + 1;
    const identifier = typeof value === 'string' ? value : String(value);
    if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
      return { position, identifier, status: 'invalid' };
    }
    const earlier = firstSeen.get(value);
    if (earlier !== undefined) {
      return {
        position,
        identifier,
        status: 'duplicate',
        firstPosition: earlier,
      };
    }
    firstSeen.set(value, position);
    const status: Top300Status = !known
      ? 'unchecked'
      : known.has(value)
        ? 'resolved'
        : 'unknown';
    return { position, identifier, status };
  });

  const ids = [...firstSeen.keys()];
  return {
    entries,
    ids,
    duplicates: entries.filter((e) => e.status === 'duplicate'),
    invalid: entries.filter((e) => e.status === 'invalid'),
    unknown: entries.filter((e) => e.status === 'unknown'),
    targetSize: TOP300_TARGET_SIZE,
    isComplete: ids.length === TOP300_TARGET_SIZE,
  };
}

/** `id → 1-based queue position` for the validated list. */
export function top300Positions(ids: readonly string[]): Map<string, number> {
  return new Map(ids.map((id, i) => [id, i + 1]));
}

/**
 * Sort rows into list order. Rows whose id is not in the list sort last (by
 * id), so a caller can never reshuffle the explicit order by what it fetched.
 */
export function sortByTop300<T extends { id: string }>(
  rows: readonly T[],
  positions: ReadonlyMap<string, number>,
): T[] {
  const rank = (r: T) => positions.get(r.id) ?? Number.MAX_SAFE_INTEGER;
  return [...rows].sort(
    (a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id),
  );
}
