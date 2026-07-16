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

export interface SeedCategory {
  id: string;
  name: string; // English label (schema PartCategory.name)
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

// ── Categories (from CATALOG_SYSTEMS, order = array order) ────────────────────
// id + English label copied verbatim. labelRu/categoryKey/iconKey are dropped
// (no columns) — see DROPPED_FRONTEND_METADATA.
export const SEED_CATEGORIES: SeedCategory[] = [
  { id: 'brakes', name: 'Brake System' },
  { id: 'maintenance', name: 'Maintenance & Fluids' },
  { id: 'suspension', name: 'Suspension & Steering' },
  { id: 'electrical', name: 'Electrical & Lighting' },
  { id: 'engine', name: 'Engine' },
  { id: 'transmission', name: 'Transmission' },
  { id: 'climate', name: 'Heating & Cooling' },
  { id: 'tuning', name: 'Tuning & Accessories' },
];

// ── Dealers (from MATOR_DEALERS) ─────────────────────────────────────────────
// id/name/initial/color/orders/years copied verbatim from the frontend
// MATOR_DEALERS. ratingAvg has no frontend source → schema default 0.
export const SEED_DEALERS: SeedDealer[] = [
  { id: 'd1', name: 'AutoPro Parts', ratingAvg: 0, initial: 'A', color: '#2A6FDB', orders: '18k+', years: 12 },
  { id: 'd2', name: 'Prime Motors Supply', ratingAvg: 0, initial: 'P', color: '#1F8A5B', orders: '9.4k+', years: 8 },
  { id: 'd3', name: 'Genuine OEM Depot', ratingAvg: 0, initial: 'G', color: '#D97757', orders: '5.1k+', years: 6 },
  { id: 'd4', name: 'TorqueLine Auto', ratingAvg: 0, initial: 'T', color: '#7c4dff', orders: '7.8k+', years: 10 },
];
