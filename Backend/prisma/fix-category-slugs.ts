/**
 * DIAGNOSE + REPAIR: root-category slugs and fiscal readiness.
 *
 * Why this exists: the admin panel shows the RAW `slug` column, while
 * `GET /v1/reference/categories` returns `slug ?? id` AND is Redis-cached (300s),
 * so the two can disagree — a NULL or duplicate slug is invisible through the
 * API but real in the DB. This script reads the column DIRECTLY (bypassing every
 * cache) so the true state is unambiguous, then repairs it.
 *
 * Repair rule: every level-0 root gets a CANONICAL, mutually-distinct slug
 * (below). Distinct-by-construction, so it cannot produce the duplicate `oil`
 * the panel reports. The write is two-phase inside one transaction — NULL the
 * targets first, then set finals — so no transient step ever collides with the
 * `slug @unique` index. Idempotent: a run where everything already matches makes
 * zero writes.
 *
 * Cache: PartCategory list caches expire on their own 300s TTL, so the API/app
 * reflect the new slugs within ~5 minutes with no manual bust. (Force it sooner
 * with: redis-cli DEL cache:reference:categories)
 *
 * This does NOT touch fiscal columns — MXIK/package codes are official TASNIF
 * values that must be entered by hand; the report only shows which roots still
 * lack them.
 *
 * Run:  npm run fix:category-slugs
 *   (= ts-node --compiler-options '{"module":"commonjs"}' prisma/fix-category-slugs.ts)
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Root id → canonical slug. Values are unique across the set by construction. */
const CANONICAL: Record<string, string> = {
  'brake-system': 'brake-system',
  transmission: 'transmissions',
  'suspension-and-steering': 'suspension-and-steering',
  'engine-system': 'engine-system',
  'heating-and-cooling': 'heating-and-cooling',
  'maintenance-and-fluids': 'maintenance-and-fluids',
  'electrical-and-lighting': 'electrical-and-lighting',
  'tuning-and-accessories': 'tuning-and-accessories',
  'motor-oil': 'motor-oil',
  cat_uncategorized: 'uncategorized',
};

function fiscalState(mxik: string | null, pkg: string | null): string {
  if (mxik && pkg) return 'CONFIGURED';
  if (mxik || pkg) return 'PARTIAL';
  return 'not-set';
}

async function main(): Promise<void> {
  // ── 1. Raw snapshot (no cache, no id-fallback) ──────────────────────────────
  const roots = await prisma.partCategory.findMany({
    where: { level: 0 },
    orderBy: { sortOrder: 'asc' },
    select: { id: true, name: true, slug: true, mxik: true, packageCodeSingle: true },
  });

  console.log('\n=== BEFORE — raw DB values for level-0 roots ===');
  console.log('id'.padEnd(26), 'slug'.padEnd(26), 'fiscal'.padEnd(11), 'name');
  for (const r of roots) {
    console.log(
      r.id.padEnd(26),
      (r.slug ?? '‹NULL›').padEnd(26),
      fiscalState(r.mxik, r.packageCodeSingle).padEnd(11),
      r.name,
    );
  }

  // Duplicate-slug scan across the WHOLE table (not just roots).
  const all = await prisma.partCategory.findMany({ select: { id: true, slug: true } });
  const bySlug = new Map<string, string[]>();
  for (const c of all) {
    if (!c.slug) continue;
    const list = bySlug.get(c.slug) ?? [];
    list.push(c.id);
    bySlug.set(c.slug, list);
  }
  const dups = [...bySlug.entries()].filter(([, ids]) => ids.length > 1);
  if (dups.length) {
    console.log('\n⚠ DUPLICATE slugs found:');
    for (const [slug, ids] of dups) console.log(`   "${slug}" → ${ids.join(', ')}`);
  } else {
    console.log('\n✓ No duplicate slugs in the table.');
  }

  // ── 2. Two-phase repair (NULL targets, then set finals) ─────────────────────
  const ids = Object.keys(CANONICAL);
  let changed = 0;
  await prisma.$transaction(async (tx) => {
    await tx.partCategory.updateMany({ where: { id: { in: ids } }, data: { slug: null } });
    for (const [id, slug] of Object.entries(CANONICAL)) {
      const exists = await tx.partCategory.findUnique({ where: { id }, select: { slug: true } });
      if (!exists) {
        console.log(`  · skip ${id} — not present`);
        continue;
      }
      // A row OUTSIDE our set already holding this slug would violate @unique.
      const clash = await tx.partCategory.findFirst({
        where: { slug, NOT: { id } },
        select: { id: true },
      });
      if (clash) {
        console.log(`  ! skip ${id} → "${slug}" — already held by ${clash.id}`);
        continue;
      }
      await tx.partCategory.update({ where: { id }, data: { slug } });
      changed++;
    }
  });

  // ── 3. After snapshot ───────────────────────────────────────────────────────
  const after = await prisma.partCategory.findMany({
    where: { level: 0 },
    orderBy: { sortOrder: 'asc' },
    select: { id: true, slug: true },
  });
  console.log('\n=== AFTER — slugs ===');
  for (const r of after) console.log(r.id.padEnd(26), r.slug ?? '‹NULL›');

  const missingFiscal = roots.filter((r) => !(r.mxik && r.packageCodeSingle));
  console.log(
    `\nDone. Slugs set on ${changed} root(s). ${missingFiscal.length} root(s) still need MXIK + package codes:`,
  );
  for (const r of missingFiscal) console.log(`   ${r.id} — ${r.name}`);
  console.log('\nReference caches expire within 300s; force now with: redis-cli DEL cache:reference:categories');
}

main()
  .catch((err) => {
    console.error('fix-category-slugs FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
