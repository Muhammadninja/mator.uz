import { Prisma } from '@prisma/client';
import { escapeLike } from '../../common/like-escape.util';
import {
  literalNumberForms,
  partNumbersInText,
} from '../../common/part-number.util';

type Where = Prisma.CatalogPartWhereInput;

/**
 * Buyer free-text search over the catalog, and how its matches rank (Wave 5).
 *
 * A part matches when:
 *   - a stored GM/OEM number equals the text as typed (or its uppercase), or
 *   - the text is (or holds, beside words) a part number — partNumbersInText —
 *     and a stored number equals its canonical form, or
 *   - the title contains the text.
 *
 * The number arrays hold every number as the seller wrote it plus its
 * canonical form (withSearchForms), labelled GM / OEM by the projection. A
 * Driver's Village position's code_1c — the manufacturer part number by the
 * owner's 2026-10-18 import rule — is indexed in oem_numbers; catalog_parts
 * has no column that tells it apart from an OEM number, so both rank as one
 * "exact number" tier.
 *
 * Only exact equality on a stored number counts: no prefix, no fuzzy number
 * match, and no cross-reference. A Wave 4 candidate or verified pair is never
 * read here, so a number on part A never lists part B.
 */

/** `has` on both arrays for each value: exact membership, GIN-indexed. */
function numberIn(values: string[]): Where | null {
  if (values.length === 0) return null;
  return {
    OR: values.flatMap((v) => [
      { oemNumbers: { has: v } },
      { gmNumbers: { has: v } },
    ]),
  };
}

/**
 * The stored values a text is looked up as, tier by tier: its literal
 * spellings, then the canonical numbers it names (minus those the literal
 * spellings already cover, as when it is typed canonically).
 */
function numberValues(text: string): {
  literal: string[];
  canonical: string[];
} {
  const literal = literalNumberForms(text);
  return {
    literal,
    canonical: partNumbersInText(text).filter((k) => !literal.includes(k)),
  };
}

/** The number conditions of a text: the literal spelling, the canonical key. */
function numberConditions(text: string): {
  literal: Where | null;
  canonical: Where | null;
} {
  const { literal, canonical } = numberValues(text);
  return { literal: numberIn(literal), canonical: numberIn(canonical) };
}

/** The fields a match is decided on. */
export interface SearchablePart {
  title: string;
  gmNumbers: readonly string[];
  oemNumbers: readonly string[];
}

/**
 * The same decision as `partTextWhere` + `relevanceTiers`, in memory: the
 * index of the tier `part` falls in for `text`, or null when it does not
 * match. For offline comparisons over a catalog snapshot; a spec holds it to
 * the Prisma predicate. Title matching is case-insensitive substring, as
 * ILIKE with the text escaped.
 */
export function searchTier(part: SearchablePart, text: string): number | null {
  const { literal, canonical } = numberValues(text);
  const holds = (values: string[]) =>
    values.some(
      (v) => part.oemNumbers.includes(v) || part.gmNumbers.includes(v),
    );
  const exact = [literal, canonical].filter((v) => v.length > 0);
  for (let i = 0; i < exact.length; i += 1) if (holds(exact[i])) return i;
  return part.title.toLowerCase().includes(text.toLowerCase())
    ? exact.length
    : null;
}

/**
 * Free text as buyers mean it: part of a title, or a part number however it
 * was typed. The one definition the listing, POST /v1/search and the
 * typeahead share, so a count and its page never disagree.
 */
export function partTextWhere(text: string): Where {
  const { literal, canonical } = numberConditions(text);
  const or: Where[] = [
    // Literal text: a `%` or `_` the buyer typed is not a wildcard (INFO-9).
    { title: { contains: escapeLike(text), mode: 'insensitive' } },
  ];
  if (literal) or.push(literal);
  if (canonical) or.push(canonical);
  return { OR: or };
}

/**
 * The relevance tiers of `text`, best first, as conditions that split
 * `partTextWhere(text)` into DISJOINT parts (each tier excludes the ones above):
 *   1. a stored number spelled exactly as typed;
 *   2. a stored number equal to a typed number's canonical form;
 *   3. everything else (title matches).
 * Under a base that includes partTextWhere(text), the tiers' counts add up to
 * the base's count. A single tier means there is nothing to rank.
 */
export function relevanceTiers(text: string): Where[] {
  const { literal, canonical } = numberConditions(text);
  const exact = [literal, canonical].filter((w): w is Where => w !== null);
  if (exact.length === 0) return [{}];
  const tiers: Where[] = [];
  exact.forEach((w, i) =>
    tiers.push(i === 0 ? w : { AND: [w, { NOT: exact.slice(0, i) }] }),
  );
  tiers.push({ NOT: exact });
  return tiers;
}

/**
 * Whether the order is the buyer's "most relevant": no sort chosen, or
 * `relevance`. An explicit price / bestseller / newest sort is kept as chosen.
 */
export function ranksByRelevance(sort: string | undefined | null): boolean {
  return !sort || sort === 'relevance';
}

/**
 * One page of `base`, tier by tier: every row of tier 1 before any of tier 2,
 * each tier in the caller's own order. Offsets run over the concatenation, so
 * pages never overlap or skip a row, and the tiers' counts sum to the count of
 * `base`. A tier the page does not reach is not fetched; the first page reads
 * no counts at all. `fetch` is the
 * caller's own findMany (its include / select / orderBy), cut by skip/take.
 */
export async function tieredPage<T>(
  count: (where: Where) => Promise<number>,
  fetch: (where: Where, skip: number, take: number) => Promise<T[]>,
  base: Where,
  tiers: Where[],
  skip: number,
  take: number,
): Promise<T[]> {
  const scoped = tiers.map((tier) =>
    Object.keys(tier).length === 0 ? base : { AND: [base, tier] },
  );
  if (take <= 0) return [];
  if (scoped.length === 1) return fetch(scoped[0], skip, take);
  if (skip === 0) {
    // The first page needs no counts: take what each tier has, in order, until
    // the page is full (a short tier is an exhausted one).
    const rows: T[] = [];
    for (const where of scoped) {
      const got = await fetch(where, 0, take - rows.length);
      rows.push(...got);
      if (rows.length >= take) break;
    }
    return rows;
  }
  const counts = await Promise.all(scoped.map((where) => count(where)));
  const slices: { where: Where; skip: number; take: number }[] = [];
  let offset = skip;
  let left = take;
  scoped.forEach((where, i) => {
    if (left <= 0) return;
    if (offset >= counts[i]) {
      offset -= counts[i];
      return;
    }
    const n = Math.min(left, counts[i] - offset);
    slices.push({ where, skip: offset, take: n });
    left -= n;
    offset = 0;
  });
  const pages = await Promise.all(
    slices.map((s) => fetch(s.where, s.skip, s.take)),
  );
  return pages.flat();
}
