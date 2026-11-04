/**
 * RE-RUNNABLE SEED: subcategory taxonomy for the buyer/admin category tree.
 *
 * Populates level-1 subcategories under the existing level-0 "system" roots of
 * PartCategory (the single source of truth for the buyer grid, the Telegram
 * seller bot, and the admin console under the /mtr-ops-… categories route).
 *
 * The tree belongs to operators once it is live, and this script cannot tell a
 * category they deleted from one that never existed. So it reports by default and
 * writes only what is asked for:
 *
 *   npm run seed:categories                         # dry-run: what differs, no writes
 *   npm run seed:categories -- --apply              # create what is missing
 *   npm run seed:categories -- --apply --overwrite  # also reset existing rows to the
 *                                                   # taxonomy: names, parent, order,
 *                                                   # and isActive back to true
 *
 * Read the dry-run before --apply: a "missing" row may be one an operator removed on
 * purpose, and --apply brings it back.
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
 * Idempotent: keyed on the deterministic slug/id, so re-runs converge and never
 * duplicate.
 */
import { PrismaClient } from '@prisma/client';
import { localizedNamesFor } from '../src/prisma/seed-data/category-names.seed';
import { TAXONOMY } from '../src/prisma/seed-data/subcategory-taxonomy.seed';

const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');
const OVERWRITE = process.argv.includes('--overwrite');

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
 * The level a root sits at, creating it only when writing. Found → returned as-is
 * (we never rename or re-slug an existing root here). Missing on a dry run → reported
 * as level 0, the level it would be created at.
 */
async function ensureRoot(parentId: string, parentName: string): Promise<number> {
  const existing = await prisma.partCategory.findUnique({
    where: { id: parentId },
    select: { id: true, level: true },
  });
  if (existing) return existing.level;

  if (!APPLY) {
    console.log(`  ! root "${parentId}" ("${parentName}") is missing`);
    return 0;
  }
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
  console.log(
    APPLY
      ? `Seeding subcategory taxonomy (${OVERWRITE ? 'create + overwrite' : 'create missing only'})…\n`
      : 'DRY RUN — nothing is written. Pass --apply to create what is missing.\n',
  );
  let missing = 0;
  let differing = 0;
  let overwritten = 0;

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

      const taxonomy = {
        name: sub.name,
        ...localizedNamesFor(id, sub.name),
        slug: id,
        level: childLevel,
        sortOrder: i,
        isActive: true,
        parent: { connect: { id: group.parentId } },
      };
      const before = await prisma.partCategory.findUnique({
        where: { id },
        select: {
          name: true,
          parentId: true,
          level: true,
          sortOrder: true,
          isActive: true,
        },
      });

      if (!before) {
        missing++;
        console.log(`   + ${id.padEnd(28)} ${sub.name}${APPLY ? '' : '  (missing)'}`);
        if (APPLY) await prisma.partCategory.create({ data: { id, ...taxonomy } });
        continue;
      }

      const differs: string[] = [
        before.name !== sub.name ? `name "${before.name}"` : '',
        before.parentId !== group.parentId ? `parent "${before.parentId}"` : '',
        before.level !== childLevel ? `level ${before.level}` : '',
        before.sortOrder !== i ? `order ${before.sortOrder}` : '',
        before.isActive ? '' : 'deactivated',
      ].filter(Boolean);
      if (differs.length === 0) continue;

      differing++;
      console.log(`   ~ ${id.padEnd(28)} differs: ${differs.join(', ')}`);
      if (APPLY && OVERWRITE) {
        await prisma.partCategory.update({ where: { id }, data: taxonomy });
        overwritten++;
      }
    }
  }

  const total = TAXONOMY.reduce((n, g) => n + g.subs.length, 0);
  console.log(
    `\nDone. ${total} subcategories checked: ${missing} missing${APPLY ? ' (created)' : ''}, ` +
      `${differing} differ from the taxonomy${APPLY && OVERWRITE ? ` (${overwritten} overwritten)` : ' (left alone)'}.`,
  );
  if (APPLY) {
    console.log('Reference caches expire within 300s; force with: redis-cli DEL cache:reference:categories');
  }
}

main()
  .catch((err) => {
    console.error('seed-categories FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
