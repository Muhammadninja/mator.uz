import {
  DealerStatus,
  OilType,
  PartCondition,
  PrismaClient,
  ProductKind,
  Prisma,
} from '@prisma/client';
import {
  SEED_LAUNCH_DEALERS,
  SEED_PART_BRANDS,
  SEED_PRODUCTS,
  SEED_SALES,
  SeedMotorOil,
  SeedProduct,
  SeedSparePart,
} from './seed-data/launch-catalog.seed';

/**
 * Loader for the launch commercial catalogue: brands → dealers → products →
 * sales.
 *
 * ── Design rules, all enforced below ────────────────────────────────────────
 *  • IDEMPOTENT — every write is an upsert keyed on the dataset's stable slug
 *    id, so a second run updates in place and creates nothing new.
 *  • DETERMINISTIC — no generated ids, no timestamps derived from "now" for
 *    identity, no random values. The same dataset yields the same rows.
 *  • NON-DESTRUCTIVE — there is no deleteMany here. A row dropped from the
 *    dataset is LEFT ALONE rather than deleted, because this seed is safe to run
 *    against a populated database and must never remove a dealer's live listing.
 *    Retiring a product is an admin action, not a seed side effect.
 *  • VALIDATED — money, percentages and foreign keys are checked before any
 *    write, and the whole load runs in ONE transaction, so a malformed dataset
 *    aborts cleanly instead of half-applying.
 *
 * Order respects FK dependencies: brands and dealers exist before the products
 * that reference them, and products exist before the sales that target them.
 */

export interface LaunchSeedCounts {
  part_brands: number;
  launch_dealers: number;
  spare_parts: number;
  motor_oils: number;
  sales: number;
}

/** Collected dataset problems. A non-empty list aborts the seed. */
class DatasetError extends Error {
  constructor(problems: string[]) {
    super(`Invalid launch dataset:\n  - ${problems.join('\n  - ')}`);
  }
}

/** Whole-UZS money must be a non-negative integer — never a float. */
function assertMoney(problems: string[], label: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    problems.push(
      `${label}: price must be a non-negative integer in whole UZS (got ${value}).`,
    );
  }
}

function assertUniqueIds(
  problems: string[],
  label: string,
  ids: string[],
): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id || !id.trim()) problems.push(`${label}: an entry has a blank id.`);
    if (seen.has(id))
      problems.push(`${label}: duplicate id "${id}" in the dataset.`);
    seen.add(id);
  }
}

const isMotorOil = (p: SeedProduct): p is SeedMotorOil =>
  p.kind === 'MOTOR_OIL';
const isSparePart = (p: SeedProduct): p is SeedSparePart =>
  p.kind === 'SPARE_PART';

/**
 * Validate the dataset in full BEFORE writing anything, reporting every problem
 * at once rather than failing on the first. Referential checks run against the
 * live database (categories and dealers may pre-exist) as well as the dataset.
 */
async function validate(prisma: PrismaClient): Promise<void> {
  const problems: string[] = [];

  assertUniqueIds(
    problems,
    'brands',
    SEED_PART_BRANDS.map((b) => b.id),
  );
  assertUniqueIds(
    problems,
    'dealers',
    SEED_LAUNCH_DEALERS.map((d) => d.id),
  );
  assertUniqueIds(
    problems,
    'products',
    SEED_PRODUCTS.map((p) => p.id),
  );
  assertUniqueIds(
    problems,
    'sales',
    SEED_SALES.map((s) => s.id),
  );

  if (SEED_PRODUCTS.length > 0) {
    // Resolve the FK universe once: dataset rows plus rows already in the DB.
    const [categories, sellers, brands] = await Promise.all([
      prisma.partCategory.findMany({ select: { id: true } }),
      prisma.catalogSeller.findMany({ select: { id: true } }),
      prisma.partBrand.findMany({ select: { id: true } }),
    ]);
    const categoryIds = new Set(categories.map((c) => c.id));
    const sellerIds = new Set([
      ...sellers.map((s) => s.id),
      ...SEED_LAUNCH_DEALERS.map((d) => d.id),
    ]);
    const brandIds = new Set([
      ...brands.map((b) => b.id),
      ...SEED_PART_BRANDS.map((b) => b.id),
    ]);

    for (const p of SEED_PRODUCTS) {
      assertMoney(problems, `product "${p.id}"`, p.priceUzs);
      if (!Number.isInteger(p.stockQty) || p.stockQty < 0) {
        problems.push(
          `product "${p.id}": stockQty must be a non-negative integer.`,
        );
      }
      if (!categoryIds.has(p.categoryId)) {
        problems.push(
          `product "${p.id}": unknown categoryId "${p.categoryId}".`,
        );
      }
      if (!sellerIds.has(p.sellerId)) {
        problems.push(`product "${p.id}": unknown sellerId "${p.sellerId}".`);
      }
      if (p.brandId && !brandIds.has(p.brandId)) {
        problems.push(`product "${p.id}": unknown brandId "${p.brandId}".`);
      }
      if (isMotorOil(p)) {
        if (!p.viscosity?.trim())
          problems.push(`motor oil "${p.id}": viscosity is required.`);
        if (!Object.values(OilType).includes(p.oilType)) {
          problems.push(
            `motor oil "${p.id}": oilType must be a valid OilType.`,
          );
        }
        if (!Number.isInteger(p.volumeMl) || p.volumeMl <= 0) {
          problems.push(
            `motor oil "${p.id}": volumeMl must be a positive integer (millilitres).`,
          );
        }
      }
    }
  }

  for (const s of SEED_SALES) {
    if (
      s.discountType === 'PERCENT' &&
      (s.discountValue <= 0 || s.discountValue > 100)
    ) {
      problems.push(`sale "${s.id}": a PERCENT discount must be in (0, 100].`);
    }
    if (s.discountType === 'FIXED')
      assertMoney(problems, `sale "${s.id}"`, s.discountValue);
    if (Number.isNaN(Date.parse(s.startAt))) {
      problems.push(`sale "${s.id}": startAt is not a valid ISO-8601 instant.`);
    }
    if (s.endAt && Number.isNaN(Date.parse(s.endAt))) {
      problems.push(`sale "${s.id}": endAt is not a valid ISO-8601 instant.`);
    }
    if (s.endAt && Date.parse(s.endAt) <= Date.parse(s.startAt)) {
      problems.push(`sale "${s.id}": endAt must be after startAt.`);
    }
    if (s.scopeType !== 'ALL_PRODUCTS' && !s.targetIds?.length) {
      problems.push(
        `sale "${s.id}": scope ${s.scopeType} requires at least one targetId.`,
      );
    }
  }

  if (problems.length > 0) throw new DatasetError(problems);
}

/** Brands. Upserted on the dataset's stable slug id. */
async function seedPartBrands(tx: Prisma.TransactionClient): Promise<void> {
  for (const b of SEED_PART_BRANDS) {
    const fields = { name: b.name, logoUrl: b.logoUrl ?? null };
    await tx.partBrand.upsert({
      where: { id: b.id },
      update: fields,
      create: { id: b.id, ...fields },
    });
  }
}

/**
 * Launch dealers. Seeded ACTIVE and curated — a dealer in this dataset is a
 * vetted launch storefront, not a self-service signup awaiting moderation.
 */
async function seedLaunchDealers(tx: Prisma.TransactionClient): Promise<void> {
  for (const d of SEED_LAUNCH_DEALERS) {
    const fields = {
      name: d.name,
      city: d.city ?? null,
      phoneE164: d.phoneE164 ?? null,
      email: d.email ?? null,
      initial: d.initial ?? null,
      // `color` is the legacy storefront field; `brandColor` is the admin
      // console's. Both point at the same supplied value so the two surfaces
      // cannot disagree.
      color: d.brandColor ?? null,
      brandColor: d.brandColor ?? null,
      years: d.years ?? null,
      ratingAvg: d.ratingAvg ?? 0,
      certified: d.certified ?? true,
      isCurated: true,
      status: DealerStatus.ACTIVE,
    };
    await tx.catalogSeller.upsert({
      where: { id: d.id },
      update: fields,
      create: { id: d.id, ...fields },
    });
  }
}

/**
 * Products. One upsert per row; fitment rows are replaced wholesale for the
 * product being seeded (delete-then-insert scoped to THAT product id) so a
 * corrected dataset does not leave stale fitment behind. This is the only
 * delete in the seed and it can never touch another product's rows.
 */
async function seedProducts(tx: Prisma.TransactionClient): Promise<void> {
  for (const p of SEED_PRODUCTS) {
    const shared = {
      title: p.title,
      categoryId: p.categoryId,
      sellerId: p.sellerId,
      brandId: p.brandId ?? null,
      priceUzs: new Prisma.Decimal(p.priceUzs),
      stockQty: p.stockQty,
      // Availability mirrors the stock count, so a seeded row cannot claim to be
      // in stock with nothing on hand.
      inStock: p.stockQty > 0,
      images: p.images ?? [],
      condition: p.condition ?? PartCondition.NEW,
      deliveryEtaDaysMin: p.deliveryEtaDaysMin ?? null,
      deliveryEtaDaysMax: p.deliveryEtaDaysMax ?? null,
    };

    // The kind-specific columns. A motor oil gets its oil attributes and NO part
    // numbers or fitment; a spare part gets the inverse. Each explicitly nulls
    // the other kind's columns so re-seeding a row that changed kind cannot
    // leave the previous kind's attributes stranded on it.
    const kindFields = isMotorOil(p)
      ? {
          kind: ProductKind.MOTOR_OIL,
          oilViscosity: p.viscosity,
          oilType: p.oilType,
          oilVolumeMl: p.volumeMl,
          oemNumbers: [],
          gmNumbers: [],
          // An oil is not fitted to a vehicle; it is universal by construction.
          isUniversal: true,
        }
      : {
          kind: ProductKind.SPARE_PART,
          oilViscosity: null,
          oilType: null,
          oilVolumeMl: null,
          oemNumbers: p.oemNumbers ?? [],
          gmNumbers: p.gmNumbers ?? [],
          isUniversal: p.isUniversal ?? false,
        };

    await tx.catalogPart.upsert({
      where: { id: p.id },
      update: { ...shared, ...kindFields },
      create: { id: p.id, ...shared, ...kindFields },
    });

    // Fitment, spare parts only. A universal part carries none by definition.
    const fits = isSparePart(p) && !p.isUniversal ? (p.fits ?? []) : [];
    await tx.catalogPartFit.deleteMany({ where: { partId: p.id } });
    for (const f of fits) {
      // Composite primary key [partId, modelSlug] — no surrogate id column.
      await tx.catalogPartFit.create({
        data: {
          partId: p.id,
          makeSlug: f.makeSlug,
          makeName: f.makeName,
          modelSlug: f.modelSlug,
          modelName: f.modelName,
        },
      });
    }
  }
}

/**
 * Sales, plus their targets. Targets are replaced wholesale per sale so a
 * re-seed cannot accumulate stale targets and silently widen a campaign.
 */
async function seedSales(tx: Prisma.TransactionClient): Promise<void> {
  for (const s of SEED_SALES) {
    const fields = {
      title: s.title,
      description: s.description ?? null,
      discountType: s.discountType,
      discountValue: new Prisma.Decimal(s.discountValue),
      scopeType: s.scopeType,
      startAt: new Date(s.startAt),
      endAt: s.endAt ? new Date(s.endAt) : null,
      isActive: s.isActive ?? true,
      priority: s.priority ?? 0,
    };
    await tx.sale.upsert({
      where: { id: s.id },
      update: fields,
      create: { id: s.id, ...fields },
    });

    await tx.saleTarget.deleteMany({ where: { saleId: s.id } });
    for (const targetId of s.targetIds ?? []) {
      await tx.saleTarget.create({
        data: {
          id: `st_${s.id}_${targetId}`,
          saleId: s.id,
          targetType: s.scopeType,
          targetId,
        },
      });
    }
  }
}

/**
 * Load the launch catalogue. Returns what was written so the caller can report
 * it. A wholly empty dataset is a legitimate outcome — a clean bootstrap with no
 * commercial catalogue supplied — and is reported rather than treated as an error.
 */
export async function seedLaunchCatalog(
  prisma: PrismaClient,
): Promise<LaunchSeedCounts> {
  await validate(prisma);

  // One transaction for the whole load: a dataset that fails partway leaves the
  // database exactly as it was, never half-seeded.
  await prisma.$transaction(async (tx) => {
    await seedPartBrands(tx);
    await seedLaunchDealers(tx);
    await seedProducts(tx);
    await seedSales(tx);
  });

  return {
    part_brands: SEED_PART_BRANDS.length,
    launch_dealers: SEED_LAUNCH_DEALERS.length,
    spare_parts: SEED_PRODUCTS.filter(isSparePart).length,
    motor_oils: SEED_PRODUCTS.filter(isMotorOil).length,
    sales: SEED_SALES.length,
  };
}

/** True when no launch commercial data has been supplied at all. */
export function launchDatasetIsEmpty(): boolean {
  return (
    SEED_PART_BRANDS.length === 0 &&
    SEED_LAUNCH_DEALERS.length === 0 &&
    SEED_PRODUCTS.length === 0 &&
    SEED_SALES.length === 0
  );
}
