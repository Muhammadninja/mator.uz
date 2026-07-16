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
  SEED_FEATURED,
  SEED_DEALERS,
} from './seed-data/catalog-reference.seed';

const prisma = new PrismaClient();

/**
 * Phase 2A — reference-data seed. Idempotent (every write is an upsert keyed on
 * the stable frontend id), so `npm run seed` can be run repeatedly and converges.
 *
 * Order respects FK dependencies: makes → models → trims (both FK back to
 * make/model). Engines are independent. Categories/featured/dealers are
 * independent reference rows.
 *
 * DATA ONLY — this file creates NO API and changes NO schema. All values come
 * verbatim from the frontend source of truth (see the seed-data/*.ts headers).
 */

async function seedAdmin() {
  const passwordHash = await bcrypt.hash('Admin12345', 10);
  await prisma.appUser.upsert({
    where: { email: 'admin@test.com' },
    update: { passwordHash, role: Role.ADMIN },
    create: { email: 'admin@test.com', passwordHash, role: Role.ADMIN },
  });
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

async function seedFeatured() {
  for (const f of SEED_FEATURED) {
    // FeaturedItem.title is NOT NULL. The frontend row carries no standalone
    // title (real titles live in a data file not provided — see Phase-2A notes),
    // so title is composed from the row's own real values (brand + model). No
    // text is invented; this is recorded in DROPPED_FRONTEND_METADATA.
    const title = `${f.brand} ${f.model}`.trim();
    await prisma.featuredItem.upsert({
      where: { id: f.id },
      update: {
        title,
        model: f.model,
        brand: f.brand,
        color: f.color,
        condition: f.condition,
        oem: f.oem,
        sortOrder: f.sortOrder,
      },
      create: {
        id: f.id,
        title,
        model: f.model,
        brand: f.brand,
        color: f.color,
        condition: f.condition,
        oem: f.oem,
        sortOrder: f.sortOrder,
      },
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
  await seedFeatured();
  await seedDealers();

  const counts = {
    vehicle_makes: await prisma.vehicleMake.count(),
    vehicle_models: await prisma.vehicleModelRef.count(),
    vehicle_trims: await prisma.vehicleTrim.count(),
    vehicle_engines: await prisma.vehicleEngine.count(),
    part_categories: await prisma.partCategory.count(),
    featured_items: await prisma.featuredItem.count(),
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
