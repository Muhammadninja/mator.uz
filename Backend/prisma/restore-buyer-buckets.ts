/**
 * DIAGNOSE + RESTORE: the 12 buyer-grid "bucket" categories (mainCategory rows).
 *
 * These are the rows GET /v1/categories serves (WHERE isActive AND mainCategory
 * IS NOT NULL). 11 of the 12 were removed from the tree, collapsing that endpoint
 * to one item. This script reads each bucket's real state (present? active?
 * mainCategory set? how many parts reference it?) and REACTIVATES it:
 *   - reactivates the row (isActive = true),
 *   - restores mainCategory / iconKey / color from the canonical map IF they were
 *     cleared (never overwrites a value that is already set),
 *   - leaves parentId UNTOUCHED, so a bucket keeps its real tree position.
 * A bucket that no longer exists (hard-deleted) is RECREATED under its natural
 * root (PARENT map) at level 1 — never at level 0, so it can't leak into the
 * systems list; the app already strips these ids from the reference drill.
 * Idempotent.
 *
 * NOTE: reactivated buckets reappear as active children under their root, i.e.
 * next to the Russian subcategories in the drill again. Only run this if you need
 * the mainCategory buckets back for the buyer grid / part classification.
 *
 * Run:  npm run restore:buyer-buckets
 *   (= ts-node --compiler-options '{"module":"commonjs"}' prisma/restore-buyer-buckets.ts)
 */
import { PrismaClient, PartMainCategory } from '@prisma/client';

const prisma = new PrismaClient();

/** The 12 canonical buyer buckets: id + the fields the grid needs. */
const BUCKETS: {
  id: string;
  name: string;
  mainCategory: PartMainCategory;
  iconKey: string;
  color: string;
}[] = [
  { id: 'brakes', name: 'Brakes', mainCategory: 'BRAKES', iconKey: 'brakes', color: '#EA4335' },
  { id: 'batteries', name: 'Batteries', mainCategory: 'BATTERIES', iconKey: 'batteries', color: '#FBBC04' },
  { id: 'filters', name: 'Filters', mainCategory: 'FILTERS', iconKey: 'filters', color: '#34A853' },
  { id: 'ignition', name: 'Ignition', mainCategory: 'IGNITION', iconKey: 'ignition', color: '#FF6D01' },
  { id: 'engine', name: 'Engine', mainCategory: 'ENGINE', iconKey: 'engine', color: '#4285F4' },
  { id: 'electrical-parts', name: 'Electrical Parts', mainCategory: 'ELECTRICAL_PARTS', iconKey: 'electrical', color: '#A142F4' },
  { id: 'oil-and-fluids', name: 'Oil & Fluids', mainCategory: 'OIL_AND_FLUIDS', iconKey: 'oil', color: '#00ACC1' },
  { id: 'belts-and-hoses', name: 'Belts & Hoses', mainCategory: 'BELTS_AND_HOSES', iconKey: 'belts', color: '#795548' },
  { id: 'wipers', name: 'Wipers', mainCategory: 'WIPERS', iconKey: 'wipers', color: '#607D8B' },
  { id: 'lighting', name: 'Lighting', mainCategory: 'LIGHTING', iconKey: 'lighting', color: '#F9AB00' },
  { id: 'suspension', name: 'Suspension', mainCategory: 'SUSPENSION', iconKey: 'suspension', color: '#009688' },
  { id: 'exterior', name: 'Exterior', mainCategory: 'EXTERIOR', iconKey: 'exterior', color: '#5F6368' },
];

/** Natural root to re-create a hard-deleted bucket under (level-1, kept out of
 *  the systems list). Only used for buckets that no longer exist. */
const PARENT: Record<string, string> = {
  brakes: 'brake-system',
  batteries: 'electrical-and-lighting',
  filters: 'maintenance-and-fluids',
  ignition: 'engine-system',
  engine: 'engine-system',
  'electrical-parts': 'electrical-and-lighting',
  'oil-and-fluids': 'maintenance-and-fluids',
  'belts-and-hoses': 'engine-system',
  wipers: 'tuning-and-accessories',
  lighting: 'electrical-and-lighting',
  suspension: 'suspension-and-steering',
  exterior: 'tuning-and-accessories',
};

async function main(): Promise<void> {
  console.log('\n=== BEFORE — bucket state ===');
  console.log('id'.padEnd(18), 'exists'.padEnd(7), 'active'.padEnd(7), 'mainCategory'.padEnd(16), 'parts');
  let reactivated = 0;
  let recreated = 0;
  const missing: string[] = [];

  for (const b of BUCKETS) {
    const row = await prisma.partCategory.findUnique({
      where: { id: b.id },
      select: { id: true, isActive: true, mainCategory: true, iconKey: true, color: true },
    });
    const parts = await prisma.catalogPart.count({ where: { categoryId: b.id } });

    if (!row) {
      // Hard-deleted → recreate under its natural root at level 1.
      const parentId = PARENT[b.id];
      const parent = parentId
        ? await prisma.partCategory.findUnique({ where: { id: parentId }, select: { level: true } })
        : null;
      if (!parent) {
        console.log(b.id.padEnd(18), 'NO'.padEnd(7), `parent ${parentId} absent — SKIP`);
        missing.push(b.id);
        continue;
      }
      await prisma.partCategory.create({
        data: {
          id: b.id,
          name: b.name,
          slug: b.id,
          mainCategory: b.mainCategory,
          iconKey: b.iconKey,
          color: b.color,
          isActive: true,
          level: parent.level + 1,
          parent: { connect: { id: parentId } },
        },
      });
      console.log(b.id.padEnd(18), 'RECREATED'.padEnd(7), `under ${parentId}`.padEnd(24), parts);
      recreated++;
      continue;
    }
    console.log(
      b.id.padEnd(18),
      'yes'.padEnd(7),
      String(row.isActive).padEnd(7),
      String(row.mainCategory ?? '‹NULL›').padEnd(16),
      parts,
    );

    // Restore visibility + any cleared grid fields (never clobber a set value).
    await prisma.partCategory.update({
      where: { id: b.id },
      data: {
        isActive: true,
        mainCategory: row.mainCategory ?? b.mainCategory,
        iconKey: row.iconKey ?? b.iconKey,
        color: row.color ?? b.color,
      },
    });
    reactivated++;
  }

  console.log(`\nDone. ${reactivated} reactivated, ${recreated} recreated.`);
  if (missing.length) {
    console.log(`⚠ ${missing.length} bucket(s) skipped (parent root absent): ${missing.join(', ')}`);
  }
  console.log('Reference caches expire within 300s; force with: redis-cli DEL cache:reference:categories');
}

main()
  .catch((err) => {
    console.error('restore-buyer-buckets FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
