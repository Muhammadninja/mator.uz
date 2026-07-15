// src/telegram/vehicle-links.ts
//
// Persists a parsed listing's vehicle compatibility onto the existing
// brands / car_models / part_models tables (no new tables):
//
//   • universal part  → NO part_models rows (plus Product.isUniversal = true,
//     written by the product upsert in the caller);
//   • otherwise       → one part_models row per (brand, model) pair, each
//     model created under ITS OWN brand — a cross-brand listing like
//     "Cobalt / Solaris" yields Chevrolet/Cobalt and Hyundai/Solaris.
//
// SINGLE vs MULTIPLE is never stored: it is derived from the number of
// part_models rows (1 → SINGLE, >1 → MULTIPLE).

import type { ParsedVehicle } from '../ai/part-parser.types';

/** The minimal Prisma slice this module needs (PrismaClient satisfies it). */
export interface VehicleLinkDb {
  brand: {
    upsert(args: {
      where: { name: string };
      update: Record<string, never>;
      create: { name: string };
    }): Promise<{ id: number }>;
  };
  carModel: {
    upsert(args: {
      where: { brandId_name: { brandId: number; name: string } };
      update: Record<string, never>;
      create: { brandId: number; name: string };
    }): Promise<{ id: number }>;
  };
  partModel: {
    upsert(args: {
      where: { partId_modelId: { partId: number; modelId: number } };
      update: Record<string, never>;
      create: { partId: number; modelId: number };
    }): Promise<unknown>;
    deleteMany(args: { where: { partId: number } }): Promise<unknown>;
  };
}

export interface VehicleCompatibilityInput {
  isUniversal: boolean;
  vehicles: ParsedVehicle[];
}

/**
 * Write the part_models rows for a product, RECONCILING against the current
 * compatibility (not just adding to it). We ALWAYS clear the product's existing
 * part_models first, then recreate from `compat.vehicles`:
 *
 *   • universal part        → cleared, nothing recreated;
 *   • specific vehicles      → cleared, then one row per (brand, model) pair;
 *   • NO vehicles (empty)    → cleared, nothing recreated.
 *
 * The clear-then-recreate is essential: a product is upserted by its GM number,
 * so a RE-LISTING of the same product with different (or no) vehicles must drop
 * the OLD links. Without the unconditional delete, a listing first published as
 * "Audi 100" and re-published later as title/description/GM-only would keep the
 * stale Audi 100 row forever — which then projects into catalog_part_fits. This
 * mirrors how the caller replaces the product gallery (deleteMany + createMany).
 *
 * Pairs without a resolvable brand are skipped — a CarModel row cannot exist
 * without a Brand. Idempotent: re-running with the same input converges.
 */
export async function persistVehicleLinks(
  db: VehicleLinkDb,
  productId: number,
  compat: VehicleCompatibilityInput,
): Promise<void> {
  // Reconcile: drop every existing link first so removed/changed vehicles do not
  // linger. This runs for the universal, specific, AND empty cases alike.
  await db.partModel.deleteMany({ where: { partId: productId } });

  if (compat.isUniversal) return;

  for (const vehicle of compat.vehicles) {
    if (!vehicle.brand) continue;
    const brand = await db.brand.upsert({
      where: { name: vehicle.brand },
      update: {},
      create: { name: vehicle.brand },
    });
    const carModel = await db.carModel.upsert({
      where: { brandId_name: { brandId: brand.id, name: vehicle.model } },
      update: {},
      create: { brandId: brand.id, name: vehicle.model },
    });
    await db.partModel.upsert({
      where: { partId_modelId: { partId: productId, modelId: carModel.id } },
      update: {},
      create: { partId: productId, modelId: carModel.id },
    });
  }
}
