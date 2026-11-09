/**
 * Normalize a part-number / OEM article for exact-match lookup.
 *
 * Buyers type article numbers with inconsistent separators and case
 * (`sp-1362`, `SP 1362`, `95231012`, `96.943.770`). Catalog OEM/GM numbers are
 * stored in `CatalogPart.oemNumbers` / `gmNumbers` in this SAME canonical form,
 * so the seed and the search path MUST run every value through this function —
 * otherwise `{ has: … }` (exact array membership) never matches.
 *
 * Rule: uppercase, then drop everything that is not A–Z or 0–9 (spaces, dashes,
 * dots, slashes, non-latin, punctuation).
 *
 *   normalizeOem(" sp- 1362. ")  === "SP1362"
 *   normalizeOem("96.943.770")   === "96943770"
 *   normalizeOem("")             === ""      (safe on empty/undefined)
 */
export function normalizeOem(query: string | null | undefined): string {
  return (query ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * The values to store for a part's number array: each as the seller wrote it, for
 * display, followed by its canonical form when that differs, for `{ has: … }` lookup.
 * Nothing is rewritten and no two parts are merged because their forms coincide.
 */
export function withSearchForms(numbers: readonly string[]): string[] {
  const out = [...numbers];
  const seen = new Set(out);
  for (const number of numbers) {
    const canonical = normalizeOem(number);
    if (canonical && !seen.has(canonical)) {
      seen.add(canonical);
      out.push(canonical);
    }
  }
  return out;
}

/** The inverse for display: drops canonical forms that exist only for lookup. */
export function displayNumbers(numbers: readonly string[]): string[] {
  const lookupOnly = new Set(
    numbers.map((n) => normalizeOem(n)).filter((c, i) => c !== numbers[i]),
  );
  return numbers.filter((n) => !lookupOnly.has(n));
}
