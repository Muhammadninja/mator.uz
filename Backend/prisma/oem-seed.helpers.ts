/**
 * Shared OEM-catalogue seeding helpers, used by both:
 *   - prisma/seed-oem.ts          (curated in-code launch set)
 *   - prisma/seed-oem-from-csv.ts (bulk import from a supplier price-list)
 *
 * A seeded part must carry CatalogPartFit rows, otherwise the buyer make/model
 * filter (`?make=Chevrolet&model=Cobalt` — what the garage "Shop parts that
 * fit" sends) excludes it. Fit rows mirror the projection's convention exactly:
 *   makeSlug  = make_<slugify(make)>
 *   modelSlug = model_<slugify(make)>_<slugify(model)>
 *   makeName / modelName = canonical display names (what the filter matches).
 */
import {
  PrismaClient,
  PartMainCategory,
  ProductKind,
  PartNumberType,
} from '@prisma/client';
import { normalizeOem } from '../src/common/normalize-oem.util';

/** The launch seller every seeded listing hangs off (FK CatalogPart.sellerId). */
export const OEM_SELLER = {
  id: 'dealer_mator_market',
  name: 'Mator Market',
  initial: 'M',
  color: '#4F46E5',
  isCurated: true,
  ratingAvg: 4.8,
};

/** Frontend id convention: "Chevrolet" → "chevrolet", "Nexia 3" → "nexia-3". */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * App-canonical model name: drop a trailing generation number so fit rows match
 * what the garage sends. The VIN decoder / catalog use base names.
 *   "Nexia 3" → "Nexia", "Tracker 2" → "Tracker", "Cobalt" → "Cobalt".
 */
export function canonicalModelName(name: string): string {
  return name.trim().replace(/\s+\d+$/, '').trim();
}

export async function ensureOemSeller(prisma: PrismaClient): Promise<void> {
  await prisma.catalogSeller.upsert({
    where: { id: OEM_SELLER.id },
    update: { name: OEM_SELLER.name, isCurated: OEM_SELLER.isCurated, ratingAvg: OEM_SELLER.ratingAvg },
    create: {
      id: OEM_SELLER.id,
      name: OEM_SELLER.name,
      initial: OEM_SELLER.initial,
      color: OEM_SELLER.color,
      isCurated: OEM_SELLER.isCurated,
      ratingAvg: OEM_SELLER.ratingAvg,
    },
  });
}

/** Resolve a subcategory slug → PartCategory (ids are slug-shaped; `slug` is unique). */
export async function resolveCategory(prisma: PrismaClient, slug: string) {
  return prisma.partCategory.findFirst({
    where: { OR: [{ slug }, { id: slug }] },
    select: { id: true, mainCategory: true },
  });
}

export interface OemSeedRecord {
  /** Stable id — upsert key (re-running converges, never duplicates). */
  id: string;
  title: string;
  /** Display brand (partBrandName); no PartBrand FK required. */
  brand: string;
  /** Vehicle make; defaults to Chevrolet. */
  make?: string;
  /** Fitment model display names (e.g. ["Cobalt","Gentra"]). */
  models: string[];
  /** One of the 52 real subcategory slugs. */
  categorySlug: string;
  /** Fallback bucket; the resolved category's own mainCategory wins when set. */
  mainCategory?: PartMainCategory | null;
  /** OEM / cross numbers (normalized on write into both arrays). */
  oemNumbers: string[];
  priceUzs: number;
  stockQty?: number;
  isOem?: boolean;
}

export type UpsertResult = 'created' | 'updated' | 'skipped';

/**
 * Idempotently upsert one CatalogPart + its make/model fit rows. Returns
 * 'skipped' when the category slug doesn't resolve (run seed:categories first).
 */
export async function upsertOemPart(
  prisma: PrismaClient,
  rec: OemSeedRecord,
): Promise<UpsertResult> {
  const category = await resolveCategory(prisma, rec.categorySlug);
  if (!category) return 'skipped';

  const mainCategory = category.mainCategory ?? rec.mainCategory ?? null;
  const codes = Array.from(new Set(rec.oemNumbers.map(normalizeOem).filter(Boolean)));
  const make = (rec.make ?? 'Chevrolet').trim();
  const makeSlug = `make_${slugify(make)}`;

  const data = {
    title: rec.title,
    categoryId: category.id,
    sellerId: OEM_SELLER.id,
    partBrandName: rec.brand,
    oemNumbers: codes,
    gmNumbers: codes,
    partNumberType: PartNumberType.UNKNOWN,
    priceUzs: rec.priceUzs,
    currency: 'UZS',
    mainCategory,
    kind: ProductKind.SPARE_PART,
    isOem: rec.isOem ?? false,
    isGm: true,
    inStock: true,
    stockQty: rec.stockQty ?? 10,
    images: [] as string[],
  };

  const existed = await prisma.catalogPart.findUnique({ where: { id: rec.id }, select: { id: true } });
  await prisma.catalogPart.upsert({ where: { id: rec.id }, update: data, create: { id: rec.id, ...data } });

  // Fit rows — replace-then-insert (idempotent; same shape as the projection).
  const byModelSlug = new Map<
    string,
    { partId: string; makeSlug: string; modelSlug: string; makeName: string; modelName: string }
  >();
  for (const raw of rec.models) {
    const modelName = canonicalModelName(raw);
    if (!modelName) continue;
    const modelSlug = `model_${slugify(make)}_${slugify(modelName)}`;
    if (!byModelSlug.has(modelSlug)) {
      byModelSlug.set(modelSlug, { partId: rec.id, makeSlug, modelSlug, makeName: make, modelName });
    }
  }
  await prisma.catalogPartFit.deleteMany({ where: { partId: rec.id } });
  const fits = [...byModelSlug.values()];
  if (fits.length > 0) await prisma.catalogPartFit.createMany({ data: fits, skipDuplicates: true });

  return existed ? 'updated' : 'created';
}
