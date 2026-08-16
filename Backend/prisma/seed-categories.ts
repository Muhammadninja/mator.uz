/**
 * RE-RUNNABLE SEED: subcategory taxonomy for the buyer/admin category tree.
 *
 * Populates level-1 subcategories under the existing level-0 "system" roots of
 * PartCategory (the single source of truth for the buyer grid, the Telegram
 * seller bot, and the admin console under the /mtr-ops-… categories route).
 *
 * Design notes (why it looks the way it does):
 *   • PartCategory has ONE display column, `name`. There is no title_ru/title_uz,
 *     so the Russian title is stored directly in `name` — same as the existing
 *     'Моторные масла' root. (Confirmed with the product owner.)
 *   • `id` IS the slug and the primary key. Russian text slugifies to empty
 *     (the admin slugify strips non-[a-z0-9]), so every subcategory carries an
 *     EXPLICIT, stable ASCII slug here — these are database PKs and must not
 *     drift between runs.
 *   • `level` is DERIVED from the parent (root = 0 → child = 1); never hardcoded
 *     blindly, it is read from the resolved parent row.
 *   • The parent `id`s below are the REAL root ids in the DB. The human-friendly
 *     slugs some tools show (brakes, engine, suspension…) are NOT the root ids;
 *     the mapping is recorded in the comment on each block.
 *
 * Idempotent: every write is an `upsert` keyed on the deterministic slug/id, so
 * re-runs converge and never duplicate. Parents are found-or-created (a missing
 * root is created at level 0 rather than aborting the run).
 *
 * Run:  npm run seed:categories
 *   (= ts-node --compiler-options '{"module":"commonjs"}' prisma/seed-categories.ts)
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** A subcategory to create under a root: Russian display name + stable ASCII slug (= id). */
interface Sub {
  name: string;
  slug: string;
}

/** One root and the subcategories to seed beneath it. */
interface RootGroup {
  /** Real PartCategory root id in the DB (NOT the friendly slug). */
  parentId: string;
  /** Canonical root display name — used only if the root is missing and must be created. */
  parentName: string;
  /** Friendly slug some tools display, kept here purely for traceability. */
  friendlySlug: string;
  subs: Sub[];
}

/**
 * The taxonomy. Parent ids are the live root ids resolved from
 * GET /v1/reference/categories; the `friendlySlug` column documents the
 * brakes→brake-system style mapping the product owner approved.
 */
const TAXONOMY: RootGroup[] = [
  {
    friendlySlug: 'brakes',
    parentId: 'brake-system',
    parentName: 'Brake System',
    subs: [
      { name: 'Передние тормозные колодки', slug: 'front-brake-pads' },
      { name: 'Задние тормозные колодки', slug: 'rear-brake-pads' },
      { name: 'Тормозные диски', slug: 'brake-discs' },
      { name: 'Суппорты и ремкомплекты', slug: 'brake-calipers-kits' },
      { name: 'Тормозные цилиндры', slug: 'brake-cylinders' },
      { name: 'Шланги и тросы', slug: 'brake-hoses-cables' },
    ],
  },
  {
    friendlySlug: 'suspension',
    parentId: 'suspension-and-steering',
    parentName: 'Suspension & Steering',
    subs: [
      { name: 'Амортизаторы', slug: 'shock-absorbers' },
      { name: 'Пружины и опоры', slug: 'springs-and-mounts' },
      { name: 'Стойки и втулки стабилизатора', slug: 'stabilizer-links-bushings' },
      { name: 'Рычаги и сайлентблоки', slug: 'control-arms-bushings' },
      { name: 'Шаровые опоры', slug: 'ball-joints' },
      { name: 'Рулевые рейки и наконечники', slug: 'steering-racks-tie-rods' },
      { name: 'Ступицы и подшипники', slug: 'wheel-hubs-bearings' },
    ],
  },
  {
    friendlySlug: 'engine',
    parentId: 'engine-system',
    parentName: 'Engine',
    subs: [
      { name: 'Комплекты ГРМ и ролики', slug: 'timing-belt-kits' },
      { name: 'Ремни навесного оборудования', slug: 'accessory-drive-belts' },
      { name: 'Прокладки и сальники', slug: 'gaskets-and-seals' },
      { name: 'Поршневая группа', slug: 'piston-group' },
      { name: 'Клапаны и ГБЦ', slug: 'valves-and-cylinder-head' },
      { name: 'Подушки двигателя', slug: 'engine-mounts' },
    ],
  },
  {
    friendlySlug: 'cooling',
    parentId: 'heating-and-cooling',
    parentName: 'Heating & Cooling',
    subs: [
      { name: 'Радиаторы охлаждения', slug: 'cooling-radiators' },
      { name: 'Радиаторы печки', slug: 'heater-cores' },
      { name: 'Водяные помпы', slug: 'water-pumps' },
      { name: 'Термостаты', slug: 'thermostats' },
      { name: 'Патрубки и бачки', slug: 'coolant-hoses-tanks' },
      { name: 'Вентиляторы охлаждения', slug: 'cooling-fans' },
    ],
  },
  {
    friendlySlug: 'oil',
    parentId: 'maintenance-and-fluids',
    parentName: 'Maintenance & Fluids',
    subs: [
      { name: 'Масляные фильтры', slug: 'oil-filters' },
      { name: 'Воздушные фильтры', slug: 'air-filters' },
      { name: 'Салонные фильтры', slug: 'cabin-filters' },
      { name: 'Топливные фильтры', slug: 'fuel-filters' },
      { name: 'Антифризы', slug: 'antifreeze' },
      { name: 'Технические жидкости', slug: 'technical-fluids' },
    ],
  },
  {
    friendlySlug: 'electrical',
    parentId: 'electrical-and-lighting',
    parentName: 'Electrical & Lighting',
    subs: [
      { name: 'Свечи зажигания', slug: 'spark-plugs' },
      { name: 'Катушки и провода', slug: 'ignition-coils-wires' },
      { name: 'Генераторы', slug: 'alternators' },
      { name: 'Стартеры', slug: 'starters' },
      { name: 'Датчики двигателя', slug: 'engine-sensors' },
      { name: 'Оптика и лампы', slug: 'headlights-and-bulbs' },
    ],
  },
  {
    friendlySlug: 'transmissions',
    parentId: 'transmission',
    parentName: 'Transmissions',
    subs: [
      { name: 'Комплекты сцепления', slug: 'clutch-kits' },
      { name: 'ШРУСы и приводы', slug: 'cv-joints-driveshafts' },
      { name: 'Пыльники ШРУСа', slug: 'cv-joint-boots' },
      { name: 'Маховики', slug: 'flywheels' },
      { name: 'Кулисы и тросы', slug: 'gear-linkages-cables' },
    ],
  },
  {
    friendlySlug: 'tuning',
    parentId: 'tuning-and-accessories',
    parentName: 'Tuning & Accessories',
    subs: [
      { name: 'Коврики', slug: 'floor-mats' },
      { name: 'Защита картера', slug: 'skid-plates' },
      { name: 'Ветровики и брызговики', slug: 'wind-deflectors-mudflaps' },
      { name: 'Чехлы', slug: 'seat-covers' },
    ],
  },
  {
    friendlySlug: 'oil-motor',
    parentId: 'motor-oil',
    parentName: 'Моторные масла',
    subs: [
      { name: 'Масло 5W-30', slug: 'motor-oil-5w30' },
      { name: 'Масло 5W-40', slug: 'motor-oil-5w40' },
      { name: 'Масло 10W-40', slug: 'motor-oil-10w40' },
      { name: 'Трансмиссионное масло', slug: 'transmission-oil' },
    ],
  },
  {
    friendlySlug: 'other',
    parentId: 'cat_uncategorized',
    parentName: 'Другое',
    subs: [
      { name: 'Крепеж и клипсы', slug: 'fasteners-and-clips' },
      { name: 'Щетки стеклоочистителя', slug: 'wiper-blades' },
    ],
  },
];

/**
 * Deterministic ASCII slug guard — mirrors the admin console's slugify so the
 * ids this seed writes match the ones the console would produce. Our slugs are
 * already ASCII, so this only normalizes/validates them.
 */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

/**
 * Ensure a root exists and return its level. Found → returned as-is (we never
 * rename or re-slug an existing root here). Missing → created as a level-0 root
 * so the run can proceed instead of aborting.
 */
async function ensureRoot(parentId: string, parentName: string): Promise<number> {
  const existing = await prisma.partCategory.findUnique({
    where: { id: parentId },
    select: { id: true, level: true },
  });
  if (existing) return existing.level;

  const created = await prisma.partCategory.create({
    data: { id: parentId, name: parentName, slug: parentId, level: 0, isActive: true },
    select: { level: true },
  });
  console.log(`  + created MISSING root "${parentId}" ("${parentName}") at level 0`);
  return created.level;
}

async function main(): Promise<void> {
  console.log('Seeding subcategory taxonomy…\n');
  let created = 0;
  let updated = 0;

  for (const group of TAXONOMY) {
    const parentLevel = await ensureRoot(group.parentId, group.parentName);
    const childLevel = parentLevel + 1;
    console.log(
      `${group.friendlySlug} → ${group.parentId} (level ${parentLevel}): ${group.subs.length} subcategories`,
    );

    for (let i = 0; i < group.subs.length; i++) {
      const sub = group.subs[i];
      const id = slugify(sub.slug);
      if (!id) throw new Error(`Empty slug for "${sub.name}" — fix the taxonomy`);

      // Detect create-vs-update purely for the run summary; the write itself is
      // a single idempotent upsert.
      const before = await prisma.partCategory.findUnique({
        where: { id },
        select: { id: true },
      });

      await prisma.partCategory.upsert({
        where: { id },
        create: {
          id,
          name: sub.name,
          slug: id,
          level: childLevel,
          sortOrder: i,
          isActive: true,
          parent: { connect: { id: group.parentId } },
        },
        update: {
          // Reconcile the row to the taxonomy on re-run: name, position, parent
          // and derived level. mainCategory is intentionally left untouched —
          // subcategories are not one of the 12 canonical buyer buckets.
          name: sub.name,
          slug: id,
          level: childLevel,
          sortOrder: i,
          isActive: true,
          parent: { connect: { id: group.parentId } },
        },
      });

      if (before) updated++;
      else created++;
      console.log(`   ${before ? '~' : '+'} ${id.padEnd(28)} ${sub.name}`);
    }
  }

  const total = TAXONOMY.reduce((n, g) => n + g.subs.length, 0);
  console.log(`\nDone. ${total} subcategories reconciled (${created} created, ${updated} updated).`);
}

main()
  .catch((err) => {
    console.error('seed-categories FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
