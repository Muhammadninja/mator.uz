/**
 * Non-vehicle reference data — transcribed BIT-FOR-BIT from the frontend source
 * of truth. Frontend wins on every value; nothing normalized or "improved".
 *
 * Sources:
 *   • CATEGORY tiles / systems  → constants/catalog-systems.ts (CATALOG_SYSTEMS)
 *   • DEALERS                    → mocks/mator-catalog.ts (MATOR_DEALERS)
 *
 * WHAT IS AND ISN'T STORED (schema is UNCHANGED):
 *   • Categories → PartCategory table (id = frontend system id, e.g. "brakes").
 *     Frontend labelRu / categoryKey / iconKey have no columns → recorded in
 *     DROPPED_FRONTEND_METADATA. The 8 systems ARE the buyer-facing category
 *     rows; the two backend enums (PartMainCategory 12, PartVehicleCategory 8)
 *     are a SEPARATE classification axis and are NOT seeded (enums, not rows).
 *   • Dealers → CatalogSeller table. Frontend initial/color/orders/years have no
 *     columns → recorded in DROPPED_FRONTEND_METADATA; only id/name are stored.
 *
 * REGIONS and QUICK FILTERS are intentionally NOT in this file — see the note in
 * seed.ts: the schema has no table for either (regions = PartOriginRegion enum +
 * ingestion classifier; quick filters = derived live from inventory). Seeding
 * them would require inventing tables, which the projection rules forbid.
 */

import { PartMainCategory } from '@prisma/client';
import { MAIN_CATEGORIES } from '../../catalog/categories/part-categories.catalog';

export interface SeedCategory {
  id: string;
  name: string; // English label (schema PartCategory.name)
  slug: string;
  color: string;
  iconKey: string;
  mainCategory: PartMainCategory;
  sortOrder: number;
}

export interface SeedDealer {
  id: string;
  name: string;
  ratingAvg: number;
  initial: string;
  color: string;
  orders: string;
  years: number;
}

// ── Categories (the 12 canonical PartCategory rows = source of truth) ─────────
// PartCategory is now the single source of truth for the buyer grid, so a fresh
// database must be seeded with the SAME 12 canonical rows the migration upserts
// (id = slug, main_category = the mirrored enum). Derived from MAIN_CATEGORIES so
// the seed can never drift from the catalog metadata. The old 8-slug CATALOG_
// SYSTEMS list was replaced — those ids ('maintenance','climate',…) are the
// orphan rows the migration deactivates.
export const SEED_CATEGORIES: SeedCategory[] = MAIN_CATEGORIES.map((c, i) => ({
  id: c.slug,
  name: c.name,
  slug: c.slug,
  color: c.color,
  iconKey: c.iconKey,
  mainCategory: c.id,
  sortOrder: i,
}));

// ── Dealers ──────────────────────────────────────────────────────────────────
// Intentionally empty. Real MATOR Certified dealers are now created by operators
// in the admin console (POST /v1/admin/dealers) with their real name and brand
// logo, so the app's certified rail shows genuine storefronts rather than the
// old placeholder mocks (AutoPro / Prime Motors / …). Left as an empty seed —
// not deleted — so `seedDealers()` stays a no-op rather than a missing import,
// and a fresh database starts with no fake dealers.
export const SEED_DEALERS: SeedDealer[] = [];
