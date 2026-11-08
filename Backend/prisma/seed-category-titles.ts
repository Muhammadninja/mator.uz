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
 * It overwrites names edited by hand, so it is guarded by
 * src/maintenance/maintenance-guard.ts:
 *
 * Run:  npm run seed:category-titles                                  (dry run, writes nothing)
 *       npm run seed:category-titles -- --apply --confirm=<code>
 *       … --allow-database=<host/db>                                  (any non-local database)
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import {
  type MaintenancePlan,
  runMaintenance,
} from '../src/maintenance/maintenance-guard';
import { CATEGORY_NAMES } from '../src/prisma/seed-data/category-names.seed';

/** The names a real run would overwrite. Reads only. */
export async function buildTitlesPlan(
  prisma: PrismaClient,
): Promise<MaintenancePlan> {
  const rows = await prisma.partCategory.findMany({
    where: { id: { in: Object.keys(CATEGORY_NAMES) } },
    select: { id: true, nameRu: true, nameUz: true, nameEn: true },
    orderBy: { id: 'asc' },
  });
  const items = rows
    .filter((r) => {
      const { ru, uz, en } = CATEGORY_NAMES[r.id];
      return r.nameRu !== ru || r.nameUz !== uz || r.nameEn !== en;
    })
    .map((r) => ({
      id: r.id,
      from: { ru: r.nameRu, uz: r.nameUz, en: r.nameEn },
      to: CATEGORY_NAMES[r.id],
    }));
  const absent = Object.keys(CATEGORY_NAMES).length - rows.length;
  return {
    summary: [
      `${items.length} categor(ies) would be renamed; ${absent} in the table are absent and skipped`,
    ],
    items,
  };
}

async function applyTitles(prisma: PrismaClient): Promise<void> {
  const { items } = await buildTitlesPlan(prisma);
  for (const { id } of items as { id: string }[]) {
    const { ru, uz, en } = CATEGORY_NAMES[id];
    await prisma.partCategory.update({
      where: { id },
      data: { nameRu: ru, nameUz: uz, nameEn: en },
    });
  }
  console.log(
    'Reference caches expire within 300s; force with: redis-cli DEL cache:reference:categories',
  );
}

export function runSeedTitles(
  prisma: PrismaClient,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
) {
  return runMaintenance({
    script: 'seed:category-titles',
    argv,
    env,
    buildPlan: () => buildTitlesPlan(prisma),
    apply: () => applyTitles(prisma),
  });
}

if (require.main === module) {
  const prisma = new PrismaClient();
  runSeedTitles(prisma, process.argv.slice(2), process.env)
    .catch((err) => {
      console.error('seed-category-titles FAILED:', err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
