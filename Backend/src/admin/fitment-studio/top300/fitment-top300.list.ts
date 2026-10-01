/**
 * THE business TOP-300 for the first release: the explicit, ORDERED list of
 * parts the Fitment Studio conveyor works through (GET
 * /v1/admin/fitment/parts-queue?filter=top300), position 1 first.
 *
 * Nothing here is derived — not from sales, ratings or reviews. The order of
 * this array IS the queue order, and only these parts are in it.
 *
 * Identifier: `CatalogPart.id` (e.g. `part_stock_1287`), the id the queue and
 * POST /v1/admin/fitment/bind already use. It names exactly ONE buyer listing.
 * An OEM number is deliberately NOT accepted: the same OEM is sold by several
 * dealers (one CatalogPart each), so it cannot pick "the" part to digitize.
 *
 * Editing: append/reorder ids here, then validate WITHOUT touching any
 * database:
 *
 *   npm run fitment:top300 -- --dry-run [--known <file of CatalogPart ids>]
 *
 * Duplicates and malformed ids fail that command and the CI spec
 * (top300-list.spec.ts). Ids that do not exist in the catalog are reported at
 * runtime in the queue's `meta.top300.missing` — never silently replaced.
 */
export const FITMENT_TOP300_PART_IDS: readonly string[] = [
  // 'part_stock_1287',
];
