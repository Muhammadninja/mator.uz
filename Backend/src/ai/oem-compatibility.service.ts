// src/ai/oem-compatibility.service.ts
//
// The ONLY place an OEM number is allowed to contribute vehicle compatibility.
// It looks the number up in the VERIFIED internal `oem_compatibility` table and
// returns the (make, model) pairs found there — nothing else. If the table has
// no row for the number, it returns an empty list: NO compatibility is inferred
// from the number's shape, and NOTHING is ever asked of the LLM. The table is
// curated manually; this service never writes to it.

import { canonicalizeBrand, canonicalizeModel } from './vehicle-catalog';
import type { ParsedVehicle } from './part-parser.types';

/** A verified compatibility row (as stored in `oem_compatibility`). */
export interface OemCompatRow {
  make: string;
  model: string;
}

/** The minimal Prisma slice this service needs (PrismaClient satisfies it). */
export interface OemCompatibilityDb {
  oemCompatibility: {
    findMany(args: {
      where: { oemNumber: string };
      select: { make: true; model: true };
    }): Promise<OemCompatRow[]>;
  };
}

/**
 * Look up verified vehicle compatibility for a raw OEM number. Returns the
 * de-duplicated (brand, model) pairs recorded in the internal database, or an
 * empty array when the number is null/blank or has no verified row.
 *
 * Make/model are canonicalized through the shared vehicle catalog so they align
 * with text-derived compatibility (e.g. "chevrolet" → "Chevrolet"); an entry
 * whose make/model the catalog doesn't know is still returned verbatim — the
 * DB is authoritative.
 */
export async function lookupOemCompatibility(
  db: OemCompatibilityDb,
  rawOemNumber: string | null | undefined,
): Promise<ParsedVehicle[]> {
  const oem = (rawOemNumber ?? '').trim();
  if (!oem) return [];

  const rows = await db.oemCompatibility.findMany({
    where: { oemNumber: oem },
    select: { make: true, model: true },
  });

  const seen = new Set<string>();
  const vehicles: ParsedVehicle[] = [];
  for (const row of rows) {
    const brand = canonicalizeBrand(row.make);
    const model = canonicalizeModel(row.model);
    if (!model) continue;
    const key = `${brand ?? ''} ${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    vehicles.push({ brand, model });
  }
  return vehicles;
}
