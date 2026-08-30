/**
 * DATA MIGRATION: retire the viscosity CATEGORIES, keeping the grade as an
 * ATTRIBUTE.
 *
 * "Масло 5W-30" was a place in the taxonomy; it is now `Product.oilViscosity`.
 * Per retired node this script, in order:
 *   1. records the grade on every Product / ProductDraft sitting there that has
 *      no viscosity of its own (a stored seller answer is never overwritten),
 *   2. re-points every reference — CatalogPart, Product, ProductDraft, and the
 *      `vehicleCategoryId` side of both — onto `motor-oil`,
 *   3. deletes the now-unreferenced category row.
 *
 * WHAT IS DELIBERATELY NOT INFERRED: the oil TYPE. Synthetic / semi-synthetic /
 * mineral is what selects an oil's MXIK, and a viscosity does not imply a base
 * composition — a 5W-40 is sold in all three. Such listings keep whatever
 * oilType they already had (usually none) and are REPORTED, so the gap is
 * visible rather than papered over with a guessed fiscal code.
 *
 * SAFE BY DEFAULT: dry-run — prints every planned change and writes nothing.
 * Pass --apply to write. Idempotent: re-running after an apply is a no-op.
 * Ordered so a failure at any point leaves the data consistent: rows move off a
 * category before it is deleted, so a partial run leaves nodes that are merely
 * empty, never rows pointing at a node that is gone.
 *
 * Run:  npm run migrate:viscosity-categories            # dry-run
 *       npm run migrate:viscosity-categories -- --apply
 */
import { PrismaClient, ProductKind } from '@prisma/client';
import {
  LEGACY_VISCOSITY_CATEGORIES,
  LEGACY_VISCOSITY_CATEGORY_IDS,
} from '../src/catalog/categories/legacy-viscosity-categories';
import { CategoryAnchor } from '../src/catalog/categories/category-map';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

/** Where every row on a retired node is re-filed: the motor-oil category itself. */
const TARGET = CategoryAnchor.MOTOR_OIL;

async function main(): Promise<void> {
  console.log(
    APPLY
      ? '── APPLYING viscosity-category migration ──'
      : '── DRY RUN (nothing is written; pass --apply to write) ──',
  );

  // The destination must exist before anything is re-pointed at it: moving rows
  // onto a missing id would fail the FK and, worse, a delete-first ordering
  // would have already dropped their old home.
  const target = await prisma.partCategory.findUnique({
    where: { id: TARGET },
  });
  if (!target) {
    console.error(
      `Target category "${TARGET}" does not exist — aborting without changes.`,
    );
    process.exitCode = 1;
    return;
  }

  const present = await prisma.partCategory.findMany({
    where: { id: { in: [...LEGACY_VISCOSITY_CATEGORY_IDS] } },
    orderBy: { id: 'asc' },
  });
  if (present.length === 0) {
    console.log('No retired viscosity categories present — nothing to do.');
    return;
  }

  let unknownType = 0;

  for (const cat of present) {
    const viscosity = LEGACY_VISCOSITY_CATEGORIES[cat.id];
    console.log(
      `\n${cat.id} → oilViscosity="${viscosity}", category="${TARGET}"`,
    );

    // A node with children is NOT deleted: its children would be orphaned, and
    // nothing in this taxonomy is supposed to hang under a viscosity anyway.
    // Report and skip — a surprise here is a data question for a human.
    const children = await prisma.partCategory.count({
      where: { parentId: cat.id },
    });
    if (children > 0) {
      console.log(`  ⚠ skipped: has ${children} child category(ies).`);
      continue;
    }

    // ── 1. The grade, onto rows that do not already carry one ────────────────
    const productsToStamp = await prisma.product.count({
      where: { categoryId: cat.id, oilViscosity: null },
    });
    const draftsToStamp = await prisma.productDraft.count({
      where: { categoryId: cat.id, oilViscosity: null },
    });
    console.log(
      `  set oilViscosity: Product=${productsToStamp} ProductDraft=${draftsToStamp}`,
    );

    // Listings that will land on motor-oil with NO oil type: fiscally
    // incomplete, and honestly so. Counted and reported, never guessed.
    const missingType = await prisma.product.count({
      where: { categoryId: cat.id, kind: ProductKind.MOTOR_OIL, oilType: null },
    });
    unknownType += missingType;
    if (missingType > 0) {
      console.log(
        `  ⓘ ${missingType} MOTOR_OIL product(s) have no oilType — left null ` +
          `(a viscosity does not imply a base composition; MXIK stays unset).`,
      );
    }

    // ── 2. Re-point every reference ──────────────────────────────────────────
    const [parts, products, drafts, productsVeh, draftsVeh] = await Promise.all(
      [
        prisma.catalogPart.count({ where: { categoryId: cat.id } }),
        prisma.product.count({ where: { categoryId: cat.id } }),
        prisma.productDraft.count({ where: { categoryId: cat.id } }),
        prisma.product.count({ where: { vehicleCategoryId: cat.id } }),
        prisma.productDraft.count({ where: { vehicleCategoryId: cat.id } }),
      ],
    );
    console.log(
      `  re-point: CatalogPart=${parts} Product=${products} ProductDraft=${drafts} ` +
        `Product.vehicleCategoryId=${productsVeh} ProductDraft.vehicleCategoryId=${draftsVeh}`,
    );

    if (!APPLY) {
      console.log('  (dry run — no writes)');
      continue;
    }

    // One transaction per category: either that node is fully emptied and gone,
    // or it is untouched. A failure cannot leave rows stranded on a deleted id.
    await prisma.$transaction(async (tx) => {
      await tx.product.updateMany({
        where: { categoryId: cat.id, oilViscosity: null },
        data: { oilViscosity: viscosity },
      });
      await tx.productDraft.updateMany({
        where: { categoryId: cat.id, oilViscosity: null },
        data: { oilViscosity: viscosity },
      });

      await tx.catalogPart.updateMany({
        where: { categoryId: cat.id },
        data: { categoryId: TARGET },
      });
      await tx.product.updateMany({
        where: { categoryId: cat.id },
        data: { categoryId: TARGET },
      });
      await tx.productDraft.updateMany({
        where: { categoryId: cat.id },
        data: { categoryId: TARGET },
      });
      // The root side of the pair, so no row keeps a dangling lineage.
      await tx.product.updateMany({
        where: { vehicleCategoryId: cat.id },
        data: { vehicleCategoryId: TARGET },
      });
      await tx.productDraft.updateMany({
        where: { vehicleCategoryId: cat.id },
        data: { vehicleCategoryId: TARGET },
      });

      // ── 3. Drop the now-unreferenced node ─────────────────────────────────
      await tx.partCategory.delete({ where: { id: cat.id } });
    });
    console.log('  ✔ migrated and deleted.');
  }

  if (unknownType > 0) {
    console.log(
      `\n⚠ ${unknownType} motor-oil product(s) still have no oilType and ` +
        `therefore no MXIK. They need a seller/admin answer — this script will ` +
        `not invent one.`,
    );
  }
  console.log(
    APPLY ? '\nDone.' : '\nDry run complete — re-run with --apply to write.',
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
