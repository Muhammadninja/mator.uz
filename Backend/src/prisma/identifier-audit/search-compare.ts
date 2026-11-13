import { normalizeOem } from '../../common/normalize-oem.util';
import {
  MIN_NUMBER_BESIDE_WORDS,
  partNumberKey,
} from '../../common/part-number.util';
import { searchTier } from '../../catalog/search/part-relevance';
import type { AuditPart, AuditSnapshot } from './identifier-audit.snapshot';

/**
 * Old vs new buyer search on the same queries, over a catalog snapshot
 * (Wave 5). Pure and READ-ONLY: no database, nothing written.
 *
 * Both sides use the listing's default order — no sort / `relevance` —
 * over the parts a buyer can see (`listed`; a hidden category is not
 * evaluated, see the snapshot SQL):
 *   before: title contains the text OR a stored number equals
 *           normalizeOem(whole text); newest first.
 *   after:  partTextWhere + relevanceTiers (via searchTier): exact numbers
 *           first, then titles; newest first within a tier.
 */

export type QuerySource =
  | 'file'
  | 'number_as_stored'
  | 'number_lowercase'
  | 'number_canonical'
  | 'short_number_beside_word'
  | 'title_words';

export interface CompareQuery {
  text: string;
  source: QuerySource;
}

export type CompareStatus = 'identical' | 'reordered' | 'changed';

export interface QueryComparison extends CompareQuery {
  before: string[];
  after: string[];
  status: CompareStatus;
  /** Listed by the new search only. */
  gained: string[];
  /** Listed by the old search only. */
  lost: string[];
  /** The first page (pageSize) differs, in content or order. */
  firstPageChanged: boolean;
}

export interface SourceSummary {
  source: QuerySource;
  queries: number;
  identical: number;
  reordered: number;
  changed: number;
  withLost: number;
  withGained: number;
  firstPageChanged: number;
}

export interface SearchComparison {
  pageSize: number;
  listedParts: number;
  summaries: SourceSummary[];
  comparisons: QueryComparison[];
}

/** The pre-Wave-5 predicate, frozen: kept only to compare against. */
export function legacyMatches(part: AuditPart, text: string): boolean {
  const canonical = normalizeOem(text);
  return (
    part.title.toLowerCase().includes(text.toLowerCase()) ||
    (canonical.length > 0 &&
      (part.oemNumbers.includes(canonical) ||
        part.gmNumbers.includes(canonical)))
  );
}

/** Newest first, then id — the listing's default order (partOrderBy). */
function newestFirst(a: AuditPart, b: AuditPart): number {
  const t = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (t !== 0) return t;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function searchBefore(parts: AuditPart[], text: string): string[] {
  return parts
    .filter((p) => legacyMatches(p, text))
    .sort(newestFirst)
    .map((p) => p.id);
}

export function searchAfter(parts: AuditPart[], text: string): string[] {
  return parts
    .map((p) => ({ p, tier: searchTier(p, text) }))
    .filter((x): x is { p: AuditPart; tier: number } => x.tier !== null)
    .sort((a, b) => a.tier - b.tier || newestFirst(a.p, b.p))
    .map((x) => x.p.id);
}

const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

export function compareQuery(
  parts: AuditPart[],
  query: CompareQuery,
  pageSize: number,
): QueryComparison {
  const before = searchBefore(parts, query.text);
  const after = searchAfter(parts, query.text);
  const inBefore = new Set(before);
  const inAfter = new Set(after);
  const gained = after.filter((id) => !inBefore.has(id));
  const lost = before.filter((id) => !inAfter.has(id));
  const status: CompareStatus = sameList(before, after)
    ? 'identical'
    : gained.length === 0 && lost.length === 0
      ? 'reordered'
      : 'changed';
  return {
    ...query,
    before,
    after,
    status,
    gained,
    lost,
    firstPageChanged: !sameList(
      before.slice(0, pageSize),
      after.slice(0, pageSize),
    ),
  };
}

/** Lowercase words of 3+ letters (or digits) — a buyer's typed title words. */
function titleWords(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3);
}

/**
 * Queries derived from the snapshot itself, for when no real query log
 * exists: every stored number as stored, in lowercase and canonical; each
 * short number beside the first word of its part's title (the case Wave 5
 * stops looking up); and the first one and two words of every title.
 */
export function generateQueries(snapshot: AuditSnapshot): CompareQuery[] {
  const out = new Map<string, CompareQuery>();
  const add = (text: string, source: QuerySource) => {
    const t = text.trim();
    if (t && !out.has(`${source}\u0000${t}`))
      out.set(`${source}\u0000${t}`, { text: t, source });
  };
  for (const part of snapshot.parts) {
    if (!part.listed) continue;
    const word = titleWords(part.title)[0];
    for (const stored of [...part.gmNumbers, ...part.oemNumbers]) {
      add(stored, 'number_as_stored');
      add(stored.toLowerCase(), 'number_lowercase');
      const canonical = normalizeOem(stored);
      if (canonical) add(canonical, 'number_canonical');
      const key = partNumberKey(stored);
      if (
        word &&
        key &&
        /[0-9]/.test(key) &&
        key.length < MIN_NUMBER_BESIDE_WORDS
      )
        add(`${word} ${stored}`, 'short_number_beside_word');
    }
    const words = titleWords(part.title);
    if (words.length > 0) add(words[0], 'title_words');
    if (words.length > 1) add(`${words[0]} ${words[1]}`, 'title_words');
  }
  return [...out.values()];
}

export function compareSearch(
  snapshot: AuditSnapshot,
  queries: CompareQuery[],
  pageSize = 20,
): SearchComparison {
  const listed = snapshot.parts.filter((p) => p.listed);
  const comparisons = queries.map((q) => compareQuery(listed, q, pageSize));
  const bySource = new Map<QuerySource, SourceSummary>();
  for (const c of comparisons) {
    const s = bySource.get(c.source) ?? {
      source: c.source,
      queries: 0,
      identical: 0,
      reordered: 0,
      changed: 0,
      withLost: 0,
      withGained: 0,
      firstPageChanged: 0,
    };
    s.queries += 1;
    s[c.status] += 1;
    if (c.lost.length > 0) s.withLost += 1;
    if (c.gained.length > 0) s.withGained += 1;
    if (c.firstPageChanged) s.firstPageChanged += 1;
    bySource.set(c.source, s);
  }
  return {
    pageSize,
    listedParts: listed.length,
    summaries: [...bySource.values()],
    comparisons,
  };
}

/** The comparison as text: a summary per query source, then the differences. */
export function formatSearchComparison(
  result: SearchComparison,
  source: string,
  examples = 15,
): string {
  const out = [
    'Buyer search: before vs after Wave 5 — READ-ONLY, nothing was changed',
    `Source: ${source}`,
    `Listed parts: ${result.listedParts}; first page = ${result.pageSize} results; default order (no sort)`,
    '',
    'source                     queries  identical  reordered  changed  lost  gained  page-1 changed',
  ];
  for (const s of result.summaries) {
    out.push(
      [
        s.source.padEnd(26),
        String(s.queries).padStart(7),
        String(s.identical).padStart(10),
        String(s.reordered).padStart(10),
        String(s.changed).padStart(8),
        String(s.withLost).padStart(5),
        String(s.withGained).padStart(7),
        String(s.firstPageChanged).padStart(15),
      ].join(' '),
    );
  }
  for (const s of result.summaries) {
    const diffs = result.comparisons.filter(
      (c) => c.source === s.source && c.status !== 'identical',
    );
    if (diffs.length === 0) continue;
    out.push('', `## ${s.source}: ${diffs.length} queries differ`);
    for (const c of diffs.slice(0, examples)) {
      const parts = [`${JSON.stringify(c.text)} [${c.status}]`];
      if (c.lost.length) parts.push(`lost ${c.lost.join(', ')}`);
      if (c.gained.length) parts.push(`gained ${c.gained.join(', ')}`);
      if (c.status === 'reordered')
        parts.push(
          `top before ${c.before.slice(0, 3).join(', ')} → after ${c.after.slice(0, 3).join(', ')}`,
        );
      out.push(`  - ${parts.join('; ')}`);
    }
    if (diffs.length > examples)
      out.push(`  … ${diffs.length - examples} more (use --all or --json)`);
  }
  return out.join('\n');
}
