/**
 * BACKFILL (B): re-file existing parts from their bucket/root onto a SUBCATEGORY.
 *
 * The bot historically filed parts on the 12 mainCategory buckets (or the
 * synthetic fallback). This maps each part's text → the best subcategory leaf via
 * {@link classifySubcategory}, scoped to the part's own system root, and sets
 * `categoryId` to that leaf. Both sides are updated so buyer + supply agree and
 * the change survives a future projection:
 *   - Product     (supply source; projection honors product.categoryId first)
 *   - CatalogPart (buyer read; what the app lists under a subcategory)
 *
 * SAFE BY DEFAULT: dry-run — prints every planned move and changes nothing.
 * Pass --apply to write. Idempotent: a row already on a subcategory is skipped,
 * and re-running after apply is a no-op. A row the classifier can't place is left
 * exactly where it is.
 *
 * Run:  npm run reclassify:subcategories          # dry-run
 *       npm run reclassify:subcategories -- --apply
 */
import { PrismaClient, PartVehicleCategory } from '@prisma/client';
import { classifySubcategory, SUBCATEGORY_IDS } from '../src/ai/subcategory-classifier';
import { VEHICLE_CATEGORY_TO_SLUG } from '../src/catalog/categories/category-map';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

/** Bucket id → its root, so a part sitting on a bucket still gets a root hint. */
const BUCKET_ROOT: Record<string, string> = {
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

/** The system root a part belongs to, best-effort from its enums / current id. */
function rootHint(
  currentCategoryId: string | null,
  vehicleCategory: PartVehicleCategory | null,
  vehicleCategoryId?: string | null,
): string | null {
  if (vehicleCategoryId) return vehicleCategoryId;
  if (vehicleCategory) return VEHICLE_CATEGORY_TO_SLUG[vehicleCategory] ?? null;
  if (currentCategoryId && BUCKET_ROOT[currentCategoryId]) return BUCKET_ROOT[currentCategoryId];
  return null;
}

type Plan = { table: string; id: string; from: string | null; to: string; title: string };

async function reclassifyProducts(): Promise<Plan[]> {
  const rows = await prisma.product.findMany({
    select: { id: true, title: true, description: true, categoryId: true, vehicleCategoryId: true, vehicleCategory: true },
  });
  const plans: Plan[] = [];
  for (const p of rows) {
    if (p.categoryId && SUBCATEGORY_IDS.has(p.categoryId)) continue; // already on a sub
    const text = [p.title, p.description].filter(Boolean).join(' ');
    const match = classifySubcategory(text, rootHint(p.categoryId, p.vehicleCategory, p.vehicleCategoryId));
    if (!match || match.id === p.categoryId) continue;
    plans.push({ table: 'Product', id: String(p.id), from: p.categoryId, to: match.id, title: p.title });
    if (APPLY) {
      await prisma.product.update({
        where: { id: p.id },
        // Keep root lineage coherent with the chosen leaf.
        data: { categoryId: match.id, vehicleCategoryId: match.root },
      });
    }
  }
  return plans;
}

async function reclassifyCatalogParts(): Promise<Plan[]> {
  const rows = await prisma.catalogPart.findMany({
    select: { id: true, title: true, partBrandName: true, oemNumbers: true, categoryId: true, vehicleCategory: true },
  });
  const plans: Plan[] = [];
  for (const c of rows) {
    if (SUBCATEGORY_IDS.has(c.categoryId)) continue; // already on a sub
    const text = [c.title, c.partBrandName, ...(c.oemNumbers ?? [])].filter(Boolean).join(' ');
    const match = classifySubcategory(text, rootHint(c.categoryId, c.vehicleCategory));
    if (!match || match.id === c.categoryId) continue;
    plans.push({ table: 'CatalogPart', id: c.id, from: c.categoryId, to: match.id, title: c.title });
    if (APPLY) {
      await prisma.catalogPart.update({ where: { id: c.id }, data: { categoryId: match.id } });
    }
  }
  return plans;
}

async function main(): Promise<void> {
  console.log(APPLY ? 'APPLYING reclassification…\n' : 'DRY-RUN (no writes; pass --apply to persist)\n');
  const plans = [...(await reclassifyProducts()), ...(await reclassifyCatalogParts())];

  if (plans.length === 0) {
    console.log('Nothing to reclassify — every part is already on a subcategory or unmatchable.');
  } else {
    console.log('table'.padEnd(13), 'from'.padEnd(20), '→ to'.padEnd(26), 'title');
    for (const p of plans) {
      console.log(p.table.padEnd(13), String(p.from ?? '‹null›').padEnd(20), `→ ${p.to}`.padEnd(26), p.title.slice(0, 48));
    }
  }
  console.log(`\n${APPLY ? 'Applied' : 'Would change'} ${plans.length} row(s).`);
  if (APPLY) console.log('Reference/catalog caches expire within 300s; force with: redis-cli DEL cache:reference:categories');
}

main()
  .catch((err) => {
    console.error('reclassify-subcategories FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
