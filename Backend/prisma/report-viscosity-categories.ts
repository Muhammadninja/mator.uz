/**
 * DIAGNOSTIC (read-only): what the live tree still holds for the retired
 * viscosity categories, and whether every row on them can be migrated safely.
 *
 * Writes NOTHING. Run this before `migrate:viscosity-categories` — the migration
 * refuses to delete a category that still has rows, so this is what tells you
 * whether the migration will complete or stop short, and why.
 *
 * Run:  npm run report:viscosity-categories
 */
import { PrismaClient } from '@prisma/client';
import {
  LEGACY_VISCOSITY_CATEGORIES,
  LEGACY_VISCOSITY_CATEGORY_IDS,
} from '../src/catalog/categories/legacy-viscosity-categories';
import { MOTOR_OIL_CATEGORY_IDS } from '../src/catalog/categories/category-map';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  console.log('── Retired viscosity categories ─────────────────────────────');

  const rows = await prisma.partCategory.findMany({
    where: { id: { in: [...LEGACY_VISCOSITY_CATEGORY_IDS] } },
    orderBy: { id: 'asc' },
  });

  if (rows.length === 0) {
    console.log('None present — the tree is already free of viscosity nodes.');
  }
  for (const c of rows) {
    console.log(
      `\n${c.id}  ("${c.name}")\n` +
        `  parentId=${c.parentId ?? 'NULL'} level=${c.level} ` +
        `isActive=${c.isActive} slug=${c.slug ?? 'NULL'}\n` +
        `  mxik=${c.mxik ?? 'NULL'} packageCodeSingle=${c.packageCodeSingle ?? 'NULL'}\n` +
        `  names ru/uz/en = "${c.nameRu}" / "${c.nameUz}" / "${c.nameEn}"\n` +
        `  → migrates to oilViscosity="${LEGACY_VISCOSITY_CATEGORIES[c.id]}"`,
    );

    // Every FK that can point at a category. CatalogPart is the one that BLOCKS
    // a delete (onDelete: Restrict, and its categoryId is NOT NULL); Product and
    // ProductDraft would silently become NULL, which is why they are re-pointed
    // rather than left to the database.
    const [parts, products, drafts, productsVeh, draftsVeh, children] =
      await Promise.all([
        prisma.catalogPart.count({ where: { categoryId: c.id } }),
        prisma.product.count({ where: { categoryId: c.id } }),
        prisma.productDraft.count({ where: { categoryId: c.id } }),
        prisma.product.count({ where: { vehicleCategoryId: c.id } }),
        prisma.productDraft.count({ where: { vehicleCategoryId: c.id } }),
        prisma.partCategory.count({ where: { parentId: c.id } }),
      ]);
    console.log(
      `  references: CatalogPart=${parts} (BLOCKS delete) ` +
        `Product.categoryId=${products} ProductDraft.categoryId=${drafts}\n` +
        `              Product.vehicleCategoryId=${productsVeh} ` +
        `ProductDraft.vehicleCategoryId=${draftsVeh} childCategories=${children}`,
    );

    // How many already carry a viscosity of their own. Those keep it: a stored
    // answer from the seller outranks an inference from the node they sit on.
    const [prodWith, draftWith] = await Promise.all([
      prisma.product.count({
        where: { categoryId: c.id, oilViscosity: { not: null } },
      }),
      prisma.productDraft.count({
        where: { categoryId: c.id, oilViscosity: { not: null } },
      }),
    ]);
    console.log(
      `  already have oilViscosity: Product=${prodWith}/${products} ` +
        `ProductDraft=${draftWith}/${drafts} (kept as-is, never overwritten)`,
    );

    if (children > 0) {
      console.log(
        `  ⚠ has ${children} child categor(y|ies) — the migration will NOT ` +
          `delete it; reparent or remove them first.`,
      );
    }
  }

  // The nodes that MUST survive, printed so the run is evidence they were not
  // touched rather than a claim that they were not.
  console.log(
    '\n── Must survive (not touched by the migration) ──────────────',
  );
  const keep = await prisma.partCategory.findMany({
    where: {
      id: {
        in: ['motor-oil', 'antifreeze', ...MOTOR_OIL_CATEGORY_IDS],
      },
    },
    orderBy: { id: 'asc' },
  });
  for (const c of keep) {
    const parts = await prisma.catalogPart.count({
      where: { categoryId: c.id },
    });
    console.log(
      `${c.id}  ("${c.name}") parentId=${c.parentId ?? 'NULL'} ` +
        `isActive=${c.isActive} CatalogPart=${parts}`,
    );
  }
  for (const expected of MOTOR_OIL_CATEGORY_IDS) {
    if (!keep.some((c) => c.id === expected)) {
      console.log(
        `⚠ ${expected} is MISSING — run the 20260831000000 migration, or the ` +
          `wizard will offer fewer than four options.`,
      );
    }
  }

  console.log('\n── Current children of motor-oil ───────────────────────────');
  const kids = await prisma.partCategory.findMany({
    where: { parentId: 'motor-oil' },
    orderBy: { sortOrder: 'asc' },
  });
  for (const k of kids) {
    console.log(`  ${k.id}  ("${k.name}") isActive=${k.isActive}`);
  }
  if (kids.length === 0) console.log('  (none)');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
