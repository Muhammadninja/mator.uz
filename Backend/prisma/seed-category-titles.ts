/**
 * RE-RUNNABLE BACKFILL: the localized display names (name_ru / name_uz /
 * name_en) of the category tree — the system roots, the 12 buyer buckets and
 * every seeded subcategory.
 *
 * The translations themselves are NOT declared here: they live in the shared
 * table `src/prisma/seed-data/category-names.seed.ts`, which every seed path
 * also writes from, so this script can never disagree with a fresh seed.
 *
 * `name` (the internal canonical label) is left untouched. Idempotent: every
 * write is an `update` keyed on the stable id, so re-runs converge. Rows whose
 * id is absent from the table are skipped with a note rather than created —
 * this only annotates existing rows.
 *
 * Run:  npm run seed:category-titles
 *   (= ts-node --compiler-options '{"module":"commonjs"}' prisma/seed-category-titles.ts)
 */
import { PrismaClient } from '@prisma/client';
import { CATEGORY_NAMES } from '../src/prisma/seed-data/category-names.seed';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const ids = Object.keys(CATEGORY_NAMES);
  console.log(`Backfilling localized names for ${ids.length} categories…\n`);
  let updated = 0;
  let missing = 0;

  for (const id of ids) {
    const { ru, uz, en } = CATEGORY_NAMES[id];
    const exists = await prisma.partCategory.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) {
      console.log(`  · skip ${id} — not present`);
      missing++;
      continue;
    }
    await prisma.partCategory.update({
      where: { id },
      data: { nameRu: ru, nameUz: uz, nameEn: en },
    });
    updated++;
  }

  console.log(
    `\nDone. ${updated} categories localized, ${missing} skipped (absent).`,
  );
  console.log(
    'Reference caches expire within 300s; force with: redis-cli DEL cache:reference:categories',
  );
}

main()
  .catch((err) => {
    console.error('seed-category-titles FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
