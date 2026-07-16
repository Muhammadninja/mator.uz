/**
 * Reference vehicle catalog — transcribed BIT-FOR-BIT from the frontend source
 * of truth `services/uz-vehicle-catalog.ts` (UZ_BRANDS / UZ_MODELS /
 * UZ_GENERATIONS / UZ_TRIMS / UZ_ENGINES).
 *
 * Frontend is the SOURCE OF TRUTH: ids, labels, order, relations and engine
 * links are copied verbatim — NOT normalized, corrected, or "improved". If a
 * value here differs from the frontend file, the frontend file wins and this
 * file is the bug.
 *
 * PROJECTION RULES (frontend 5 levels → backend 4-level schema, schema UNCHANGED):
 *   • VehicleBrand      → VehicleMake        (id = frontend brand id, e.g. "chevrolet")
 *   • VehicleModel      → VehicleModelRef    (id = frontend model id, e.g. "cobalt")
 *   • VehicleGeneration → NOT stored as an entity. Its identity is preserved
 *     INSIDE the trim id/slug (e.g. "cobalt-p2-premier"). yearRange is NOT
 *     migrated — year-based fitment lives in PartCompatibility.years[] (a
 *     deliberate Do-NOT-change decision).
 *   • VehicleTrim       → VehicleTrim. id = frontend trim id (already carries the
 *     generation, e.g. "cobalt-p2-premier"). modelId resolves through
 *     generation → model, so it ALWAYS points at the model (e.g. "cobalt").
 *   • VehicleEngine     → VehicleEngine. id/label copied verbatim. displacementCc
 *     = displacement * 1000 (litres → cc). fuelType derived conservatively from
 *     `type`. Frontend-only fields (type, transmissions, oemCatalogScope) do NOT
 *     fit the schema and are recorded in DROPPED_FRONTEND_METADATA below —
 *     nothing is dropped silently.
 *
 * The trim↔engine M:N (`engineIds`) also has no column in the schema (the buyer
 * `Vehicle` row picks one trimId + one engineId; part fitment lives in
 * PartCompatibility). It is likewise recorded in DROPPED_FRONTEND_METADATA.
 */

export interface SeedMake {
  id: string;
  name: string;
  sortOrder: number;
}

export interface SeedModel {
  id: string;
  makeId: string;
  name: string;
  sortOrder: number;
}

export interface SeedTrim {
  id: string;
  modelId: string;
  name: string;
  sortOrder: number;
}

export interface SeedEngine {
  id: string;
  name: string;
  displacementCc: number | null;
  fuelType: 'PETROL' | 'DIESEL' | 'HYBRID' | 'ELECTRIC' | 'GAS' | null;
  sortOrder: number;
}

// ── Makes (from UZ_BRANDS, order = array order) ──────────────────────────────
export const SEED_MAKES: SeedMake[] = [
  { id: 'chevrolet', name: 'Chevrolet', sortOrder: 0 },
  { id: 'byd', name: 'BYD', sortOrder: 1 },
  { id: 'daewoo', name: 'Daewoo', sortOrder: 2 },
  { id: 'kia', name: 'Kia', sortOrder: 3 },
  { id: 'chery', name: 'Chery', sortOrder: 4 },
  { id: 'hyundai', name: 'Hyundai', sortOrder: 5 },
  { id: 'lada', name: 'Lada', sortOrder: 6 },
  { id: 'toyota', name: 'Toyota', sortOrder: 7 },
  { id: 'haval', name: 'Haval', sortOrder: 8 },
  { id: 'nissan', name: 'Nissan', sortOrder: 9 },
];

// ── Models (from UZ_MODELS; sortOrder = index in the UZ_MODELS array) ─────────
// sortOrder reproduces the frontend catalog order — the frontend's per-model
// `order` field is not carried (no column), so the array index is the ordering
// source. See docs/REFERENCE_DATA_GAPS.md (Phase 2C).
export const SEED_MODELS: SeedModel[] = [
  { id: 'cobalt', makeId: 'chevrolet', name: 'Cobalt', sortOrder: 0 },
  { id: 'malibu', makeId: 'chevrolet', name: 'Malibu', sortOrder: 1 },
  { id: 'nexia', makeId: 'chevrolet', name: 'Nexia', sortOrder: 2 },
  { id: 'lacetti', makeId: 'chevrolet', name: 'Lacetti', sortOrder: 3 },
  { id: 'gentra', makeId: 'chevrolet', name: 'Gentra', sortOrder: 4 },
  { id: 'spark', makeId: 'chevrolet', name: 'Spark', sortOrder: 5 },
  { id: 'tracker', makeId: 'chevrolet', name: 'Tracker', sortOrder: 6 },
  { id: 'captiva', makeId: 'chevrolet', name: 'Captiva', sortOrder: 7 },
  { id: 'onix', makeId: 'chevrolet', name: 'Onix', sortOrder: 8 },
  { id: 'damas', makeId: 'chevrolet', name: 'Damas', sortOrder: 9 },
  { id: 'matiz', makeId: 'daewoo', name: 'Matiz', sortOrder: 10 },
  { id: 'tico', makeId: 'daewoo', name: 'Tico', sortOrder: 11 },
  { id: 'byd-chazor', makeId: 'byd', name: 'Chazor', sortOrder: 12 },
  { id: 'byd-song-plus', makeId: 'byd', name: 'Song Plus', sortOrder: 13 },
  { id: 'byd-han', makeId: 'byd', name: 'Han', sortOrder: 14 },
  { id: 'kia-k5', makeId: 'kia', name: 'K5', sortOrder: 15 },
  { id: 'kia-sportage', makeId: 'kia', name: 'Sportage', sortOrder: 16 },
  { id: 'kia-rio', makeId: 'kia', name: 'Rio', sortOrder: 17 },
  { id: 'chery-tiggo-7-pro', makeId: 'chery', name: 'Tiggo 7 Pro', sortOrder: 18 },
  { id: 'chery-tiggo-8-pro', makeId: 'chery', name: 'Tiggo 8 Pro', sortOrder: 19 },
  { id: 'hyundai-sonata', makeId: 'hyundai', name: 'Sonata', sortOrder: 20 },
  { id: 'hyundai-tucson', makeId: 'hyundai', name: 'Tucson', sortOrder: 21 },
  { id: 'hyundai-creta', makeId: 'hyundai', name: 'Creta', sortOrder: 22 },
  { id: 'lada-niva', makeId: 'lada', name: 'Niva', sortOrder: 23 },
  { id: 'lada-granta', makeId: 'lada', name: 'Granta', sortOrder: 24 },
];

// ── Trims (from UZ_TRIMS; modelId resolved via generation → model) ───────────
// The frontend trim id already encodes the generation (e.g. "cobalt-p2-premier"),
// so it is used verbatim. modelId is the generation's modelId (Cobalt, not P2).
export const SEED_TRIMS: SeedTrim[] = [
  { id: 'cobalt-p1-elegant', modelId: 'cobalt', name: 'Elegant', sortOrder: 0 },
  { id: 'cobalt-p2-elegant', modelId: 'cobalt', name: 'Elegant', sortOrder: 1 },
  { id: 'cobalt-p2-premier', modelId: 'cobalt', name: 'Premier', sortOrder: 2 },
  { id: 'cobalt-p3-elegant', modelId: 'cobalt', name: 'Elegant', sortOrder: 3 },
  { id: 'cobalt-p3-premier', modelId: 'cobalt', name: 'Premier', sortOrder: 4 },
  { id: 'cobalt-p4-ls', modelId: 'cobalt', name: 'LS', sortOrder: 5 },
  { id: 'cobalt-p4-ltz', modelId: 'cobalt', name: 'LTZ', sortOrder: 6 },
  { id: 'malibu-1-lt', modelId: 'malibu', name: 'LT', sortOrder: 7 },
  { id: 'malibu-1-ltz', modelId: 'malibu', name: 'LTZ', sortOrder: 8 },
  { id: 'malibu-2-lt', modelId: 'malibu', name: 'LT', sortOrder: 9 },
  { id: 'malibu-2-premier', modelId: 'malibu', name: 'Premier', sortOrder: 10 },
  { id: 'nexia-2-base', modelId: 'nexia', name: 'Base', sortOrder: 11 },
  { id: 'nexia-2-dlx', modelId: 'nexia', name: 'DLX', sortOrder: 12 },
  { id: 'nexia-3-ls', modelId: 'nexia', name: 'LS', sortOrder: 13 },
  { id: 'nexia-3-lt', modelId: 'nexia', name: 'LT', sortOrder: 14 },
  { id: 'lacetti-sx', modelId: 'lacetti', name: 'SX', sortOrder: 15 },
  { id: 'gentra-base', modelId: 'gentra', name: 'Base', sortOrder: 16 },
  { id: 'gentra-elegant', modelId: 'gentra', name: 'Elegant', sortOrder: 17 },
  { id: 'spark-m400-ls', modelId: 'spark', name: 'LS', sortOrder: 18 },
  { id: 'tracker-3-premier', modelId: 'tracker', name: 'Premier', sortOrder: 19 },
  { id: 'captiva-5-premier', modelId: 'captiva', name: 'Premier', sortOrder: 20 },
  { id: 'onix-1-premier', modelId: 'onix', name: 'Premier', sortOrder: 21 },
  { id: 'damas-2-base', modelId: 'damas', name: 'Base', sortOrder: 22 },
  { id: 'byd-chazor-pro', modelId: 'byd-chazor', name: 'Pro', sortOrder: 23 },
  { id: 'byd-song-plus-flagship', modelId: 'byd-song-plus', name: 'Flagship', sortOrder: 24 },
  { id: 'byd-han-ev', modelId: 'byd-han', name: 'EV', sortOrder: 25 },
];

// ── Engines (from UZ_ENGINES) ────────────────────────────────────────────────
// displacementCc = displacement(litres) * 1000. fuelType derived conservatively
// from the frontend `type`: na/turbo → PETROL, ev → ELECTRIC, phev/hybrid →
// HYBRID (schema has no PHEV member). The frontend `type`, `transmissions`, and
// `oemCatalogScope` do not map to columns — see DROPPED_FRONTEND_METADATA.
export const SEED_ENGINES: SeedEngine[] = [
  { id: 'b15d2-na', name: '1.5L On-Turbo (B15D2)', displacementCc: 1500, fuelType: 'PETROL', sortOrder: 0 },
  { id: 'b15d2-turbo', name: '1.5L Turbo (B15D2)', displacementCc: 1500, fuelType: 'PETROL', sortOrder: 1 },
  { id: 'b12d2', name: '1.2L (B12D2)', displacementCc: 1200, fuelType: 'PETROL', sortOrder: 2 },
  { id: 'lcv-1-3', name: '1.3L LCV', displacementCc: 1300, fuelType: 'PETROL', sortOrder: 3 },
  { id: 'malibu-1-5t', name: '1.5L Turbo (LFV)', displacementCc: 1500, fuelType: 'PETROL', sortOrder: 4 },
  { id: 'malibu-2-0t', name: '2.0L Turbo (LTG)', displacementCc: 2000, fuelType: 'PETROL', sortOrder: 5 },
  { id: 'lacetti-1-6', name: '1.6L (F16D3)', displacementCc: 1600, fuelType: 'PETROL', sortOrder: 6 },
  { id: 'byd-blade-ev', name: 'Blade Battery EV', displacementCc: null, fuelType: 'ELECTRIC', sortOrder: 7 },
  { id: 'byd-dmi', name: 'DM-i PHEV', displacementCc: 1500, fuelType: 'HYBRID', sortOrder: 8 },
];
