/**
 * OEM catalogue seed — real UZ-market spare parts with OEM / cross numbers.
 *
 * Populates the BUYER projection table `catalog_parts` directly (idempotent
 * upsert on a stable `id`), so parts appear immediately on the storefront
 * (GET /v1/catalog/parts) and are findable by article number via the new
 * `{ oemNumbers: { has } }` / `{ gmNumbers: { has } }` search (GIN-indexed).
 *
 * Why direct CatalogPart (not the supply Product → projection path): the
 * projection carries a SINGLE `Product.oemNumber`, whereas a real listing needs
 * the OEM PLUS its cross-references (`['95231012','SP1362','96943770']`). The
 * buyer array `oemNumbers[]` is the right home for that set, so we write it here.
 *
 * Every code is stored through `normalizeOem` (uppercase, no separators) — the
 * SAME transform the search path applies — so exact article match works.
 *
 * ⚠️ OEM / cross numbers below are real-world GM-UZ / aftermarket references but
 *    MUST be validated against the official parts catalogue before go-live;
 *    correct any number and re-run — the upsert converges on the same `id`.
 *
 * Run:  npm run seed:oem
 */
import { PrismaClient, PartMainCategory } from '@prisma/client';
import { ensureOemSeller, upsertOemPart, type OemSeedRecord } from './oem-seed.helpers';

const prisma = new PrismaClient();

type SeedOemPart = {
  id: string;
  title: string;
  brand: string; // partBrandName (denormalized display); no PartBrand FK needed
  vehicle: string; // documentation only
  categorySlug: string; // one of the 52 real subcategory slugs
  mainCategory: PartMainCategory; // fallback bucket; overridden by the category's own mainCategory when set
  oemNumbers: string[]; // originals + cross-codes (normalized on write)
  priceUzs: number; // whole UZS
  isOem?: boolean; // genuine GM part
};

/** 36 real UZ-market positions across Cobalt / Gentra / Nexia 3 / Spark / Tracker 2 / Damas. */
const SEED_OEM_PARTS: SeedOemPart[] = [
  // ── BRAKES ──────────────────────────────────────────────────────────────
  { id: 'oem_cobalt_front_pads', title: 'Тормозные колодки передние Cobalt/Gentra', brand: 'Hi-Q', vehicle: 'Cobalt/Gentra', categorySlug: 'front-brake-pads', mainCategory: 'BRAKES', oemNumbers: ['95939923', 'SP1362', '95233442'], priceUzs: 210000 },
  { id: 'oem_cobalt_front_pads_gm', title: 'Тормозные колодки передние Cobalt (оригинал GM)', brand: 'Chevrolet GM', vehicle: 'Cobalt', categorySlug: 'front-brake-pads', mainCategory: 'BRAKES', oemNumbers: ['95939923', '96475028'], priceUzs: 385000, isOem: true },
  { id: 'oem_nexia3_front_pads', title: 'Тормозные колодки передние Nexia 3', brand: 'Mando', vehicle: 'Nexia 3', categorySlug: 'front-brake-pads', mainCategory: 'BRAKES', oemNumbers: ['13301207', 'MPH50', '96843177'], priceUzs: 245000 },
  { id: 'oem_spark_front_pads', title: 'Тормозные колодки передние Spark', brand: 'Hi-Q', vehicle: 'Spark', categorySlug: 'front-brake-pads', mainCategory: 'BRAKES', oemNumbers: ['95048166', 'SP1194', '96473231'], priceUzs: 175000 },
  { id: 'oem_gentra_rear_pads', title: 'Тормозные колодки задние Gentra', brand: 'Mando', vehicle: 'Gentra', categorySlug: 'rear-brake-pads', mainCategory: 'BRAKES', oemNumbers: ['13502056', '96534653'], priceUzs: 195000 },
  { id: 'oem_cobalt_front_disc', title: 'Тормозной диск передний Cobalt', brand: 'Chevrolet GM', vehicle: 'Cobalt', categorySlug: 'brake-discs', mainCategory: 'BRAKES', oemNumbers: ['13502213', '96574633'], priceUzs: 320000, isOem: true },
  { id: 'oem_tracker_front_disc', title: 'Тормозной диск передний Tracker 2', brand: 'Mando', vehicle: 'Tracker 2', categorySlug: 'brake-discs', mainCategory: 'BRAKES', oemNumbers: ['13502045', '42423892'], priceUzs: 410000 },

  // ── SUSPENSION / STEERING ───────────────────────────────────────────────
  { id: 'oem_cobalt_shock_front', title: 'Амортизатор передний Cobalt/Gentra', brand: 'Mando', vehicle: 'Cobalt/Gentra', categorySlug: 'shock-absorbers', mainCategory: 'SUSPENSION', oemNumbers: ['95459741', '96980817'], priceUzs: 520000 },
  { id: 'oem_nexia3_shock_front', title: 'Амортизатор передний Nexia 3', brand: 'CTR', vehicle: 'Nexia 3', categorySlug: 'shock-absorbers', mainCategory: 'SUSPENSION', oemNumbers: ['95190983'], priceUzs: 465000 },
  { id: 'oem_spark_shock_rear', title: 'Амортизатор задний Spark', brand: 'Mando', vehicle: 'Spark', categorySlug: 'shock-absorbers', mainCategory: 'SUSPENSION', oemNumbers: ['95996292'], priceUzs: 430000 },
  { id: 'oem_cobalt_ball_joint', title: 'Опора шаровая Cobalt/Gentra', brand: 'CTR', vehicle: 'Cobalt/Gentra', categorySlug: 'ball-joints', mainCategory: 'SUSPENSION', oemNumbers: ['94566212', 'CBKD11', '96391851'], priceUzs: 145000 },
  { id: 'oem_nexia3_ball_joint', title: 'Опора шаровая Nexia 3', brand: 'CTR', vehicle: 'Nexia 3', categorySlug: 'ball-joints', mainCategory: 'SUSPENSION', oemNumbers: ['96181287', '96391847'], priceUzs: 138000 },
  { id: 'oem_cobalt_control_arm', title: 'Рычаг передний нижний Cobalt', brand: 'CTR', vehicle: 'Cobalt', categorySlug: 'control-arms-bushings', mainCategory: 'SUSPENSION', oemNumbers: ['96967199', '95950767'], priceUzs: 640000 },
  { id: 'oem_gentra_tie_rod_end', title: 'Наконечник рулевой Gentra', brand: 'CTR', vehicle: 'Gentra', categorySlug: 'steering-racks-tie-rods', mainCategory: 'SUSPENSION', oemNumbers: ['96534843', 'CEKD22'], priceUzs: 120000 },
  { id: 'oem_cobalt_stab_link', title: 'Стойка стабилизатора Cobalt/Gentra', brand: 'CTR', vehicle: 'Cobalt/Gentra', categorySlug: 'stabilizer-links-bushings', mainCategory: 'SUSPENSION', oemNumbers: ['13272090', 'CLKD16'], priceUzs: 95000 },
  { id: 'oem_spark_wheel_hub', title: 'Ступица передняя с подшипником Spark', brand: 'Hi-Q', vehicle: 'Spark', categorySlug: 'wheel-hubs-bearings', mainCategory: 'SUSPENSION', oemNumbers: ['95983428', '96549771'], priceUzs: 380000 },

  // ── FILTERS ─────────────────────────────────────────────────────────────
  { id: 'oem_cobalt_oil_filter', title: 'Масляный фильтр Cobalt/Gentra/Spark', brand: 'Hi-Q', vehicle: 'Cobalt/Gentra/Spark', categorySlug: 'oil-filters', mainCategory: 'FILTERS', oemNumbers: ['25183779', '96570765', '96565412'], priceUzs: 42000 },
  { id: 'oem_nexia3_oil_filter', title: 'Масляный фильтр Nexia 3', brand: 'Chevrolet GM', vehicle: 'Nexia 3', categorySlug: 'oil-filters', mainCategory: 'FILTERS', oemNumbers: ['25183779', '55594651'], priceUzs: 55000, isOem: true },
  { id: 'oem_cobalt_air_filter', title: 'Воздушный фильтр Cobalt/Gentra', brand: 'Hi-Q', vehicle: 'Cobalt/Gentra', categorySlug: 'air-filters', mainCategory: 'FILTERS', oemNumbers: ['13501194', '96950990'], priceUzs: 58000 },
  { id: 'oem_spark_air_filter', title: 'Воздушный фильтр Spark', brand: 'Hi-Q', vehicle: 'Spark', categorySlug: 'air-filters', mainCategory: 'FILTERS', oemNumbers: ['96837470', '25060299'], priceUzs: 52000 },
  { id: 'oem_cobalt_cabin_filter', title: 'Салонный фильтр Cobalt/Gentra/Tracker', brand: 'Hi-Q', vehicle: 'Cobalt/Gentra/Tracker 2', categorySlug: 'cabin-filters', mainCategory: 'FILTERS', oemNumbers: ['13503675', '96440878'], priceUzs: 65000 },
  { id: 'oem_nexia3_fuel_filter', title: 'Топливный фильтр Nexia 3/Spark', brand: 'Hi-Q', vehicle: 'Nexia 3/Spark', categorySlug: 'fuel-filters', mainCategory: 'FILTERS', oemNumbers: ['96335719', '25055129'], priceUzs: 78000 },

  // ── IGNITION ────────────────────────────────────────────────────────────
  { id: 'oem_cobalt_spark_plug', title: 'Свеча зажигания Cobalt/Gentra (к-т 4 шт)', brand: 'NGK', vehicle: 'Cobalt/Gentra', categorySlug: 'spark-plugs', mainCategory: 'IGNITION', oemNumbers: ['25186681', 'BKR6E', '96307100'], priceUzs: 110000 },
  { id: 'oem_spark_spark_plug', title: 'Свеча зажигания Spark (к-т 4 шт)', brand: 'NGK', vehicle: 'Spark', categorySlug: 'spark-plugs', mainCategory: 'IGNITION', oemNumbers: ['25182600', 'BPR6ES'], priceUzs: 96000 },
  { id: 'oem_cobalt_ignition_coil', title: 'Катушка зажигания Cobalt/Gentra', brand: 'NGK', vehicle: 'Cobalt/Gentra', categorySlug: 'ignition-coils-wires', mainCategory: 'IGNITION', oemNumbers: ['25198623', '96476979'], priceUzs: 285000 },

  // ── BELTS AND HOSES ─────────────────────────────────────────────────────
  { id: 'oem_cobalt_timing_belt_kit', title: 'Комплект ГРМ Cobalt/Gentra 1.5', brand: 'Gates', vehicle: 'Cobalt/Gentra', categorySlug: 'timing-belt-kits', mainCategory: 'BELTS_AND_HOSES', oemNumbers: ['K015603XS', '25190262'], priceUzs: 720000 },
  { id: 'oem_nexia3_accessory_belt', title: 'Ремень приводной Nexia 3/Cobalt', brand: 'Gates', vehicle: 'Nexia 3/Cobalt', categorySlug: 'accessory-drive-belts', mainCategory: 'BELTS_AND_HOSES', oemNumbers: ['6PK1123', '25190846'], priceUzs: 130000 },

  // ── ENGINE / COOLING ────────────────────────────────────────────────────
  { id: 'oem_cobalt_water_pump', title: 'Помпа водяная Cobalt/Gentra 1.5', brand: 'Hi-Q', vehicle: 'Cobalt/Gentra', categorySlug: 'water-pumps', mainCategory: 'ENGINE', oemNumbers: ['25195119', '96473689'], priceUzs: 340000 },
  { id: 'oem_cobalt_thermostat', title: 'Термостат Cobalt/Gentra', brand: 'Hi-Q', vehicle: 'Cobalt/Gentra', categorySlug: 'thermostats', mainCategory: 'ENGINE', oemNumbers: ['25192228', '96984103'], priceUzs: 115000 },
  { id: 'oem_spark_radiator', title: 'Радиатор охлаждения Spark', brand: 'Hi-Q', vehicle: 'Spark', categorySlug: 'cooling-radiators', mainCategory: 'ENGINE', oemNumbers: ['95316164'], priceUzs: 690000 },
  { id: 'oem_cobalt_engine_mount', title: 'Опора двигателя правая Cobalt', brand: 'CTR', vehicle: 'Cobalt', categorySlug: 'engine-mounts', mainCategory: 'ENGINE', oemNumbers: ['13248477', '96852033'], priceUzs: 260000 },

  // ── ELECTRICAL ──────────────────────────────────────────────────────────
  { id: 'oem_cobalt_alternator', title: 'Генератор Cobalt/Gentra 1.5', brand: 'Mando', vehicle: 'Cobalt/Gentra', categorySlug: 'alternators', mainCategory: 'ELECTRICAL_PARTS', oemNumbers: ['42438568', '25191875'], priceUzs: 1250000 },
  { id: 'oem_nexia3_starter', title: 'Стартер Nexia 3/Cobalt', brand: 'Mando', vehicle: 'Nexia 3/Cobalt', categorySlug: 'starters', mainCategory: 'ELECTRICAL_PARTS', oemNumbers: ['25191962', '55352348'], priceUzs: 980000 },

  // ── TRANSMISSION-ish (no dedicated bucket → ENGINE) ─────────────────────
  { id: 'oem_cobalt_clutch_kit', title: 'Комплект сцепления Cobalt/Gentra', brand: 'Hi-Q', vehicle: 'Cobalt/Gentra', categorySlug: 'clutch-kits', mainCategory: 'ENGINE', oemNumbers: ['25182974', '96863503'], priceUzs: 890000 },
  { id: 'oem_damas_cv_joint', title: 'ШРУС наружный Damas', brand: 'CTR', vehicle: 'Damas', categorySlug: 'cv-joints-driveshafts', mainCategory: 'ENGINE', oemNumbers: ['96286097'], priceUzs: 310000 },

  // ── WIPERS / LIGHTING ───────────────────────────────────────────────────
  { id: 'oem_cobalt_wiper_set', title: 'Щётки стеклоочистителя Cobalt/Gentra (к-т)', brand: 'Hi-Q', vehicle: 'Cobalt/Gentra', categorySlug: 'wiper-blades', mainCategory: 'WIPERS', oemNumbers: ['95368171', '95459527'], priceUzs: 88000 },
  { id: 'oem_tracker_headlight', title: 'Фара передняя правая Tracker 2', brand: 'Chevrolet GM', vehicle: 'Tracker 2', categorySlug: 'headlights-and-bulbs', mainCategory: 'LIGHTING', oemNumbers: ['42678115'], priceUzs: 1450000, isOem: true },
];

async function main() {
  await ensureOemSeller(prisma);

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const part of SEED_OEM_PARTS) {
    // The `vehicle` field ("Cobalt/Gentra", "Nexia 3/Spark") is the fitment set;
    // split it into models so upsertOemPart writes CatalogPartFit rows and the
    // part shows under `?make=Chevrolet&model=<...>` (the garage "fit" filter).
    const record: OemSeedRecord = {
      id: part.id,
      title: part.title,
      brand: part.brand,
      make: 'Chevrolet',
      models: part.vehicle.split('/').map((m) => m.trim()).filter(Boolean),
      categorySlug: part.categorySlug,
      mainCategory: part.mainCategory,
      oemNumbers: part.oemNumbers,
      priceUzs: part.priceUzs,
      isOem: part.isOem,
    };
    const result = await upsertOemPart(prisma, record);
    if (result === 'created') created += 1;
    else if (result === 'updated') updated += 1;
    else {
      // eslint-disable-next-line no-console
      console.warn(`✗ skip "${part.id}": category slug "${part.categorySlug}" not found (run seed:categories first)`);
      skipped += 1;
    }
  }

  const total = await prisma.catalogPart.count();
  // eslint-disable-next-line no-console
  console.log(`✓ seed:oem done — created ${created}, updated ${updated}, skipped ${skipped}. catalog_parts total now ${total}.`);
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('seed:oem failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
