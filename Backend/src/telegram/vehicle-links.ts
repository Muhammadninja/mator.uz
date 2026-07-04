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
 * Write the part_models rows for a product. Universal parts get their stale
 * rows removed (a re-listed product may have had specific links before) and
 * nothing created. Pairs without a resolvable brand are skipped — a CarModel
 * row cannot exist without a Brand. Idempotent: upserts throughout.
 */
export async function persistVehicleLinks(
  db: VehicleLinkDb,
  productId: number,
  compat: VehicleCompatibilityInput,
): Promise<void> {
  if (compat.isUniversal) {
    await db.partModel.deleteMany({ where: { partId: productId } });
    return;
  }

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
