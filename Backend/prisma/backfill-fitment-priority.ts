/**
 * RE-RUNNABLE BACKFILL: seed the Fitment Studio queue (`catalog_parts.fitment_priority`).
 *
 * §2 of the Fitment Studio backend plan picked an explicit column over deriving
 * "top 300" from order lines, because a derived queue can never contain a new
 * SKU nobody has bought yet — and those are exactly the rows an operator wants
 * digitized before a season starts. The column is the source of truth; this
 * script only writes the FIRST pass, ranked by the signals we already have:
 *
 *   salesCount desc → isBestseller → ratingAvg desc → reviewCount desc → id asc
 *
 * The tail of that ordering is arbitrary among parts with no sales at all,
 * which is fine: the point is to hand the operator 300 rows to work, not to be
 * right about rank 287.
 *
 * Idempotent: it clears the existing ranks and rewrites them, so a re-run after
 * more sales data lands converges on the new order. Hand-promoted rows ARE
 * overwritten — run it once, then curate in the admin panel.
 *
 * Run:  npm run backfill:fitment-priority [-- --limit 300] [--dry-run]
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function intArg(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

async function main() {
  const limit = intArg('--limit', 300);
  const dryRun = process.argv.includes('--dry-run');

  // Only parts that still need work. An already-bound part in the top 300 would
  // occupy a queue slot the operator has nothing to do with.
  const rows = await prisma.catalogPart.findMany({
    where: { fitmentBindings: { none: {} } },
    select: { id: true, title: true, salesCount: true },
    orderBy: [
      { salesCount: 'desc' },
      { isBestseller: 'desc' },
      { ratingAvg: { sort: 'desc', nulls: 'last' } },
      { reviewCount: 'desc' },
      { id: 'asc' },
    ],
    take: limit,
  });

  console.log(
    `[fitment-priority] ${rows.length} part(s) selected (limit ${limit})`,
  );
  if (rows.length > 0) {
    const head = rows
      .slice(0, 5)
      .map((r, i) => `  ${i + 1}. ${r.title} (${r.salesCount} sold)`);
    console.log(head.join('\n'));
  }
  if (dryRun) {
    console.log('[fitment-priority] --dry-run: nothing written');
    return;
  }

  await prisma.$transaction([
    // Clear first so a shrinking list cannot leave stale ranks behind.
    prisma.catalogPart.updateMany({
      where: { fitmentPriority: { not: null } },
      data: { fitmentPriority: null },
    }),
    ...rows.map((r, i) =>
      prisma.catalogPart.update({
        where: { id: r.id },
        data: { fitmentPriority: i + 1 },
      }),
    ),
  ]);

  console.log(`[fitment-priority] ranked 1..${rows.length}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
