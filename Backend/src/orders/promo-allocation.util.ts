/**
 * Spreading an order-level promo discount ACROSS the order's product lines, so
 * the amount charged is carried entirely by item prices and no separate
 * "discount" component survives onto the order.
 *
 * Why this exists: a Payme fiscal receipt has no negative line and no discount
 * field. A receipt must reconcile as `SUM(price × count) == amount charged`,
 * where `price` is an INTEGER unit price in tiyin. An order-level discount
 * therefore has nowhere to live on the receipt — unless it is already baked into
 * the unit prices before the receipt is ever built.
 *
 * The whole calculation runs in TIYIN (integers), never in UZS floats. That is
 * what makes the result exact rather than approximately right: the guarantee
 *
 *     SUM(effective line totals) == subtotal − discount
 *
 * holds to the last tiyin, which is precisely the equality Payme re-checks.
 *
 * The two-step shape (proportional floor, then remainder) is forced by
 * integers: `floor` on each share can only ever under-allocate, and it
 * under-allocates by strictly less than one tiyin per line, so what is left over
 * is a handful of tiyin that must be placed deliberately rather than lost.
 */

/** A line entering the allocation. Prices in TIYIN, per unit. */
export interface AllocatableLine {
  /** Line identity — the key of the returned map. */
  id: string;
  /** Unit price in tiyin BEFORE the promo discount. */
  unitPriceTiyin: number;
  quantity: number;
}

/** What the allocation decided for one line. All amounts in TIYIN. */
export interface AllocatedLine {
  /** The discount this line absorbed, in tiyin. */
  discountTiyin: number;
  /** Line total after the discount — `lineTotalTiyin − discountTiyin`. */
  effectiveLineTotalTiyin: number;
  /**
   * Effective UNIT price in tiyin, `floor(effectiveLineTotal / quantity)`.
   *
   * DERIVED, and deliberately not the source of truth: for `quantity > 1` the
   * effective line total need not divide evenly, so `unitPrice × quantity` can
   * fall a few tiyin short of `effectiveLineTotalTiyin`. Callers that must
   * reconcile exactly use the line total; see `splitEvenLines` for the receipt
   * path, which is what resolves the difference.
   */
  effectiveUnitPriceTiyin: number;
}

/**
 * Allocate `discountTiyin` across `lines`, pro rata by line total.
 *
 * Returns a map keyed by line id. Guarantees, for any input:
 *
 *  - every line's discount is ≥ 0 and ≤ that line's total (no line is pushed
 *    negative, and no line absorbs more than it is worth);
 *  - `SUM(discountTiyin) === discountTiyin` exactly, when the discount does not
 *    exceed the subtotal (else it is capped AT the subtotal — an order can be
 *    reduced to zero but never below it, so the charge stays payable).
 *
 * The remainder left by flooring is handed to the HIGHEST-VALUE line first
 * (ties broken by input order, so the result is deterministic): the largest line
 * is the one most able to absorb a stray tiyin without its unit price moving
 * visibly, and a deterministic rule keeps a re-run of the same order identical.
 */
export function allocatePromoDiscount(
  lines: AllocatableLine[],
  discountTiyin: number,
): Map<string, AllocatedLine> {
  const result = new Map<string, AllocatedLine>();
  if (lines.length === 0) return result;

  const lineTotals = lines.map((l) => l.unitPriceTiyin * l.quantity);
  const subtotal = lineTotals.reduce((s, t) => s + t, 0);

  // Nothing to spread: no discount, or a subtotal of zero (which would make
  // every proportional share a division by zero). Both leave prices untouched.
  const budget = Math.max(0, Math.min(Math.trunc(discountTiyin), subtotal));
  if (budget === 0 || subtotal === 0) {
    lines.forEach((line, i) => {
      result.set(line.id, {
        discountTiyin: 0,
        effectiveLineTotalTiyin: lineTotals[i],
        effectiveUnitPriceTiyin: line.unitPriceTiyin,
      });
    });
    return result;
  }

  // Step 1 — the proportional share, floored. Multiply BEFORE dividing so the
  // ratio is never materialised as a lossy float: `budget * total` is an exact
  // integer product well inside Number's safe range for any real order.
  const shares = lineTotals.map((total) =>
    Math.floor((budget * total) / subtotal),
  );

  // Step 2 — the remainder. Flooring can only under-allocate, so this is ≥ 0,
  // and strictly less than the number of lines (each line lost < 1 tiyin).
  let remainder = budget - shares.reduce((s, v) => s + v, 0);

  // Highest line total first; the original index breaks ties so the order of
  // equal lines — and therefore the output — is stable.
  const byValue = lineTotals
    .map((total, index) => ({ total, index }))
    .sort((a, b) => b.total - a.total || a.index - b.index);

  // Capped per line, so a line can never be discounted past its own total: with
  // several lines the remainder is tiny, but a single-line order whose budget
  // equals the subtotal has no headroom left at all.
  for (const { index } of byValue) {
    if (remainder <= 0) break;
    const headroom = lineTotals[index] - shares[index];
    const take = Math.min(remainder, headroom);
    shares[index] += take;
    remainder -= take;
  }

  lines.forEach((line, i) => {
    const effectiveLineTotal = lineTotals[i] - shares[i];
    result.set(line.id, {
      discountTiyin: shares[i],
      effectiveLineTotalTiyin: effectiveLineTotal,
      effectiveUnitPriceTiyin: Math.floor(effectiveLineTotal / line.quantity),
    });
  });

  return result;
}

/** A receipt-ready line: an integer unit price and the count it applies to. */
export interface EvenLine {
  unitPriceTiyin: number;
  count: number;
}

/**
 * Express one discounted line as receipt lines whose `price × count` sums to
 * `effectiveLineTotalTiyin` EXACTLY.
 *
 * This is the step that makes an embedded discount representable at all. A line
 * of 3 units sharing a 100-tiyin discount needs 33⅓ tiyin off each unit, which
 * no integer unit price can express — so the line is SPLIT: the units that
 * absorb an extra tiyin become their own line at the higher price.
 *
 *     effectiveTotal = 100_000, count = 3
 *       → [{ price: 33_334, count: 1 }, { price: 33_333, count: 2 }]
 *         33_334 + 66_666 = 100_000 ✓
 *
 * At most TWO lines come back, and exactly one whenever the total divides
 * evenly — which is the common case, so ordinary receipts are unchanged.
 * The dearer line comes first, so the split reads as "one unit at the odd
 * price" rather than the rounding being buried at the end.
 */
export function splitEvenLines(
  effectiveLineTotalTiyin: number,
  count: number,
): EvenLine[] {
  if (count <= 0) return [];

  const base = Math.floor(effectiveLineTotalTiyin / count);
  const extra = effectiveLineTotalTiyin - base * count; // 0 ≤ extra < count

  if (extra === 0) return [{ unitPriceTiyin: base, count }];
  return [
    { unitPriceTiyin: base + 1, count: extra },
    { unitPriceTiyin: base, count: count - extra },
  ];
}
