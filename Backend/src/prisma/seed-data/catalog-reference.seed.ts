/**
 * Non-vehicle reference data — transcribed BIT-FOR-BIT from the frontend source
 * of truth. Frontend wins on every value; nothing normalized or "improved".
 *
 * Sources:
 *   • CATEGORY tiles / systems  → constants/catalog-systems.ts (CATALOG_SYSTEMS)
 *   • FEATURED grid              → services/top-featured-service.ts (MOCK_ITEM_ATTRIBUTES f1–f6)
 *   • DEALERS                    → mocks/mator-catalog.ts (MATOR_DEALERS)
 *
 * WHAT IS AND ISN'T STORED (schema is UNCHANGED):
 *   • Categories → PartCategory table (id = frontend system id, e.g. "brakes").
 *     Frontend labelRu / categoryKey / iconKey have no columns → recorded in
 *     DROPPED_FRONTEND_METADATA. The 8 systems ARE the buyer-facing category
 *     rows; the two backend enums (PartMainCategory 12, PartVehicleCategory 8)
 *     are a SEPARATE classification axis and are NOT seeded (enums, not rows).
 *   • Featured → FeaturedItem table. Frontend f1–f6 map directly onto its
 *     model/brand/color/condition/oem/badge/status columns.
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

export interface SeedFeatured {
  id: string;
  model: string;
  brand: string;
  color: string;
  condition: string;
  oem: string;
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

// ── Featured (from MOCK_ITEM_ATTRIBUTES f1–f6) ───────────────────────────────
// Order = f1..f6. FeaturedItem.title is required by the schema; the frontend
// mock attributes carry no standalone title (badge/status/title/description come
// from a separate data file not provided), so we store what the frontend row
// actually defines and leave the rest to the (nullable) columns.
export const SEED_FEATURED: SeedFeatured[] = [
  { id: 'f1', model: 'SUV', brand: 'Cobalt', color: 'Black', condition: 'New', oem: 'GM 15823942', sortOrder: 0 },
  { id: 'f2', model: 'Coupe', brand: 'BYD', color: 'White', condition: 'OEM', oem: 'BYD-1090012', sortOrder: 1 },
  { id: 'f3', model: 'Sedan', brand: 'Lacetti', color: 'Silver', condition: 'Restored', oem: 'OEM 96405028', sortOrder: 2 },
  { id: 'f4', model: 'Truck', brand: 'Tracker', color: 'Red', condition: 'Budget', oem: 'GM 13578934', sortOrder: 3 },
  { id: 'f5', model: 'SUV', brand: 'Leapmotor', color: 'Black', condition: 'New', oem: 'LM-T03-1009', sortOrder: 4 },
  { id: 'f6', model: 'Coupe', brand: 'Cobalt', color: 'Silver', condition: 'OEM', oem: 'GM 96289942', sortOrder: 5 },
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
