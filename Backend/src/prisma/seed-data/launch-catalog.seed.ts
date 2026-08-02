/**
 * The LAUNCH CATALOGUE dataset: brands, dealers, products (spare parts and motor
 * oils) and sales campaigns.
 *
 * ── Why these arrays are empty ──────────────────────────────────────────────
 * Every other seed file in this directory transcribes a real source of truth
 * (the frontend catalogue, the vehicle reference data, the SMS operator price
 * list). No such source exists yet for the launch commercial catalogue: the real
 * brand list, dealer roster, product records and promotional campaigns have not
 * been supplied to the repository.
 *
 * Fabricating them is NOT a neutral placeholder here, because these rows are
 * load-bearing in ways reference data is not:
 *   • a product carries a PRICE a customer is charged;
 *   • a sale MODIFIES that price through the live discount engine;
 *   • a dealer is a real business whose name appears on a storefront.
 * Invented values in any of those would flow straight into GET /v1/catalog/parts
 * and the checkout total. SEED_DEALERS in catalog-reference.seed.ts was emptied
 * for exactly this reason, and the same rule is applied here.
 *
 * ── What IS delivered ───────────────────────────────────────────────────────
 * The loader in seed.ts is complete and tested. Populate the arrays below with
 * the real dataset and `npm run seed` will upsert it idempotently — no further
 * code change is required. Each interface documents precisely which fields the
 * dataset must provide, which is the specification the missing input has to meet.
 *
 * ── Identity rule ───────────────────────────────────────────────────────────
 * Every row carries an explicit, stable, human-meaningful `id` (a slug, not a
 * generated ulid). The seed upserts on it, so re-running converges instead of
 * duplicating, and a product can be corrected later by re-seeding the same id.
 */

import {
  OilType,
  PartCondition,
  SaleDiscountType,
  SaleScopeType,
} from '@prisma/client';

/** A part manufacturer (Bosch, Gates, …) → PartBrand. */
export interface SeedPartBrand {
  /** Stable slug id, e.g. 'brand_bosch'. */
  id: string;
  name: string;
  /** Absolute HTTPS logo URL, or null when none is supplied. */
  logoUrl?: string | null;
}

/**
 * A launch dealer → CatalogSeller.
 *
 * NOTE: dealers can also be created by operators through the admin console
 * (POST /v1/admin/dealers), which is the intended path for onboarding after
 * launch. Seed a dealer here only when it must exist in a freshly bootstrapped
 * database before any operator has logged in.
 */
export interface SeedLaunchDealer {
  /** Stable slug id, e.g. 'dealer_autopro'. */
  id: string;
  name: string;
  city?: string | null;
  phoneE164?: string | null;
  email?: string | null;
  /** Monogram letter shown on the logo tile. */
  initial?: string | null;
  /** Brand accent, '#RRGGBB'. Applied to both `color` and `brandColor`. */
  brandColor?: string | null;
  /** Years in business, shown on the storefront. */
  years?: number | null;
  /** MATOR Certified badge. */
  certified?: boolean;
  ratingAvg?: number;
}

/** Fields shared by every launch product, whatever its kind. */
interface SeedProductBase {
  /** Stable slug id, e.g. 'part_bosch_bp1234'. */
  id: string;
  title: string;
  /** PartCategory id (must exist — see SEED_CATEGORIES). */
  categoryId: string;
  /** CatalogSeller id (must exist — a curated dealer or a seeded launch dealer). */
  sellerId: string;
  /** PartBrand id, or null when the part is unbranded. */
  brandId?: string | null;
  /** Retail price in whole UZS. Integer — never a float. */
  priceUzs: number;
  stockQty: number;
  images?: string[];
  condition?: PartCondition;
  deliveryEtaDaysMin?: number | null;
  deliveryEtaDaysMax?: number | null;
}

/** A spare part: carries part numbers and vehicle fitment. */
export interface SeedSparePart extends SeedProductBase {
  kind: 'SPARE_PART';
  /** OEM numbers this part is sold under. Only seller-labelled OEM values. */
  oemNumbers?: string[];
  gmNumbers?: string[];
  /** True when the part fits every vehicle (then `fits` must be empty). */
  isUniversal?: boolean;
  /** Make/model fitment. Ignored when isUniversal is true. */
  fits?: Array<{
    makeSlug: string;
    makeName: string;
    modelSlug: string;
    modelName: string;
  }>;
}

/**
 * A motor oil.
 *
 * Deliberately a SEPARATE type from {@link SeedSparePart}: an oil has no part
 * numbers and no vehicle fitment, and is selected by viscosity/type/volume. The
 * type system therefore refuses to accept a `fits` array on an oil, so the
 * dataset cannot push motor oil through the spare-part compatibility rules.
 */
export interface SeedMotorOil extends SeedProductBase {
  kind: 'MOTOR_OIL';
  /** SAE grade exactly as printed, e.g. '5W-30'. */
  viscosity: string;
  oilType: OilType;
  /** Package volume in millilitres, e.g. 4000 for a 4-litre can. */
  volumeMl: number;
}

export type SeedProduct = SeedSparePart | SeedMotorOil;

/**
 * A launch promotional campaign → Sale (+ SaleTarget rows).
 *
 * Seeding a sale CHANGES PRICES THE CUSTOMER PAYS, so only real, approved
 * campaign data belongs here.
 */
export interface SeedSale {
  /** Stable slug id, e.g. 'sale_launch_week'. */
  id: string;
  title: string;
  description?: string | null;
  discountType: SaleDiscountType;
  /** PERCENT: 0 < value <= 100. FIXED: whole UZS > 0. */
  discountValue: number;
  scopeType: SaleScopeType;
  /** Target ids — product ids, category ids or dealer ids. Empty for ALL_PRODUCTS. */
  targetIds?: string[];
  /** ISO-8601 instant. */
  startAt: string;
  /** ISO-8601 instant, or null for open-ended. */
  endAt?: string | null;
  isActive?: boolean;
  priority?: number;
}

// ── The launch dataset ───────────────────────────────────────────────────────
// AWAITING REAL DATA. See the file header: these stay empty until the actual
// launch catalogue is supplied. The seed treats an empty array as "nothing to
// do" and reports it, so a bootstrap run against a clean database succeeds and
// states plainly that no commercial catalogue was loaded.

export const SEED_PART_BRANDS: SeedPartBrand[] = [];

export const SEED_LAUNCH_DEALERS: SeedLaunchDealer[] = [];

export const SEED_PRODUCTS: SeedProduct[] = [];

export const SEED_SALES: SeedSale[] = [];
