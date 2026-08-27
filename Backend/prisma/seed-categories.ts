/**
 * RE-RUNNABLE SEED: subcategory taxonomy for the buyer/admin category tree.
 *
 * Populates level-1 subcategories under the existing level-0 "system" roots of
 * PartCategory (the single source of truth for the buyer grid, the Telegram
 * seller bot, and the admin console under the /mtr-ops-… categories route).
 *
 * Design notes (why it looks the way it does):
 *   • PartCategory carries THREE required display columns — name_ru / name_uz /
 *     name_en — filled from the shared translation table
 *     (src/prisma/seed-data/category-names.seed.ts). `name` remains the internal
 *     canonical label and keeps the Russian text it has always held here.
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
import { localizedNamesFor } from '../src/prisma/seed-data/category-names.seed';
import { TAXONOMY } from '../src/prisma/seed-data/subcategory-taxonomy.seed';

const prisma = new PrismaClient();

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
    data: {
      id: parentId,
      name: parentName,
      ...localizedNamesFor(parentId, parentName),
      slug: parentId,
      level: 0,
      isActive: true,
    },
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
          ...localizedNamesFor(id, sub.name),
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
          ...localizedNamesFor(id, sub.name),
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
