import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import {
  SEED_MAKES,
  SEED_MODELS,
  SEED_TRIMS,
  SEED_ENGINES,
} from './seed-data/vehicle-catalog.seed';
import {
  SEED_CATEGORIES,
  SEED_DEALERS,
} from './seed-data/catalog-reference.seed';

const prisma = new PrismaClient();

/**
 * Phase 2A — reference-data seed. Idempotent (every write is an upsert keyed on
 * the stable frontend id), so `npm run seed` can be run repeatedly and converges.
 *
 * Order respects FK dependencies: makes → models → trims (both FK back to
 * make/model). Engines are independent. Categories/dealers are independent
 * reference rows.
 *
 * DATA ONLY — this file creates NO API and changes NO schema. All values come
 * verbatim from the frontend source of truth (see the seed-data/*.ts headers).
 */

/**
 * Optional, opt-in bootstrap admin. There are NO hardcoded credentials: an admin
 * is created only when BOTH `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` are
 * provided via the environment. This makes it safe to run the seed against
 * production for reference data without ever planting a default/known-credential
 * admin account.
 *
 * Behavior:
 *   • neither var set        → skip (no admin touched) — the common case.
 *   • both vars set          → upsert an ADMIN with the given credentials.
 *   • only one var set       → fail (incomplete configuration; do not guess).
 *   • password too short     → fail (min 12 chars) so a weak bootstrap password
 *                              cannot slip into production.
 */
async function seedAdmin() {
  const email = process.env.SEED_ADMIN_EMAIL?.trim();
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (!email && !password) {
    console.log('[seed] SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD not set — skipping admin bootstrap.');
    return;
  }
  if (!email || !password) {
    throw new Error(
      'Incomplete admin bootstrap: set BOTH SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD, or neither.',
    );
  }
  if (password.length < 12) {
    throw new Error('SEED_ADMIN_PASSWORD must be at least 12 characters.');
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.appUser.upsert({
    where: { email },
    update: { passwordHash, role: Role.ADMIN },
    create: { email, passwordHash, role: Role.ADMIN },
  });
  console.log(`[seed] bootstrap admin ensured for ${email}`);
}

async function seedVehicleCatalog() {
  // Makes first (models/trims FK to them).
  for (const m of SEED_MAKES) {
    await prisma.vehicleMake.upsert({
      where: { id: m.id },
      update: { name: m.name, sortOrder: m.sortOrder },
      create: { id: m.id, name: m.name, sortOrder: m.sortOrder },
    });
  }
  // Models (FK → make). sortOrder carries the frontend catalog order.
  for (const m of SEED_MODELS) {
    await prisma.vehicleModelRef.upsert({
      where: { id: m.id },
      update: { makeId: m.makeId, name: m.name, sortOrder: m.sortOrder },
      create: { id: m.id, makeId: m.makeId, name: m.name, sortOrder: m.sortOrder },
    });
  }
  // Trims (FK → model; id already encodes the frontend generation).
  for (const t of SEED_TRIMS) {
    await prisma.vehicleTrim.upsert({
      where: { id: t.id },
      update: { modelId: t.modelId, name: t.name, sortOrder: t.sortOrder },
      create: { id: t.id, modelId: t.modelId, name: t.name, sortOrder: t.sortOrder },
    });
  }
  // Engines (independent).
  for (const e of SEED_ENGINES) {
    await prisma.vehicleEngine.upsert({
      where: { id: e.id },
      update: { name: e.name, displacementCc: e.displacementCc, fuelType: e.fuelType ?? undefined, sortOrder: e.sortOrder },
      create: { id: e.id, name: e.name, displacementCc: e.displacementCc, fuelType: e.fuelType ?? undefined, sortOrder: e.sortOrder },
    });
  }
}

async function seedCategories() {
  for (const c of SEED_CATEGORIES) {
    await prisma.partCategory.upsert({
      where: { id: c.id },
      update: { name: c.name },
      create: { id: c.id, name: c.name },
    });
  }
}

async function seedDealers() {
  for (const d of SEED_DEALERS) {
    const fields = {
      name: d.name,
      ratingAvg: d.ratingAvg,
      // SEED_DEALERS are the curated MATOR-certified dealers by definition, so
      // the curated marker is asserted here (idempotently). GET /v1/dealers
      // filters on this flag, never on field presence.
      isCurated: true,
      initial: d.initial,
      color: d.color,
      orders: d.orders,
      years: d.years,
    };
    await prisma.catalogSeller.upsert({
      where: { id: d.id },
      update: fields,
      create: { id: d.id, ...fields },
    });
  }
}

async function main() {
  await seedAdmin();
  await seedVehicleCatalog();
  await seedCategories();
  await seedDealers();

  const counts = {
    vehicle_makes: await prisma.vehicleMake.count(),
    vehicle_models: await prisma.vehicleModelRef.count(),
    vehicle_trims: await prisma.vehicleTrim.count(),
    vehicle_engines: await prisma.vehicleEngine.count(),
    part_categories: await prisma.partCategory.count(),
    catalog_sellers: await prisma.catalogSeller.count(),
  };
  console.log('[seed] reference-data row counts:');
  console.table(counts);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    // Surface a non-zero exit so a failed seed cannot be mistaken for success
    // (e.g. in `prisma migrate deploy && npm run seed` bootstrap pipelines).
    process.exit(1);
  });
