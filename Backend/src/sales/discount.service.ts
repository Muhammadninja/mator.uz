import { Injectable } from '@nestjs/common';
import { Prisma, Sale, SaleDiscountType, SaleScopeType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The minimum a product must expose to be priced. Structural, not a Prisma
 * type, so any caller can use it: a CatalogPart row, an order-item snapshot, or
 * a hand-built object in a test. Callers pass what they already have — this
 * service never re-reads the product.
 */
export interface DiscountableProduct {
  id: string;
  categoryId?: string | null;
  sellerId?: string | null;
}

/** The sale that produced a discount, as returned to callers. */
export interface AppliedSale {
  id: string;
  title: string;
  discountType: SaleDiscountType;
  discountValue: number;
}

/** Result of pricing one product. `appliedSale` is null when nothing applied. */
export interface DiscountResult {
  originalPrice: number;
  finalPrice: number;
  discountAmount: number;
  discountPercent: number;
  appliedSale: AppliedSale | null;
}

/**
 * A sale plus the targets needed to decide whether it applies. Loaded once per
 * request by `loadActiveSales` and reusable across many products.
 */
export interface ActiveSale extends Sale {
  targets: { targetType: SaleScopeType; targetId: string }[];
}

/**
 * Which product field each scope matches on. Table-driven so a new scope kind
 * is added by extending this map plus the enum — no branching to touch, which
 * is what keeps "adding a scope type later is easy" true in the code and not
 * just in the schema.
 *
 * ALL_PRODUCTS is absent by design: it matches unconditionally and never reads
 * a target row.
 */
const SCOPE_MATCHERS: Record<
  Exclude<SaleScopeType, 'ALL_PRODUCTS'>,
  (product: DiscountableProduct) => string | null | undefined
> = {
  [SaleScopeType.PRODUCTS]: (p) => p.id,
  [SaleScopeType.CATEGORIES]: (p) => p.categoryId,
  [SaleScopeType.DEALERS]: (p) => p.sellerId,
};

/**
 * Reusable automatic-discount engine. The single place in the codebase that
 * turns "a price + a product" into "a discounted price", so products, cart and
 * orders can each inject it and agree by construction.
 *
 * Deliberately has no HTTP surface of its own: SalesService owns the endpoints,
 * this owns the arithmetic and the scope resolution. Exported from SalesModule.
 *
 * ── Money ──
 * Prices are whole UZS. Percentage discounts round the DISCOUNT (not the final
 * price) to the nearest so'm, so `originalPrice - discountAmount === finalPrice`
 * holds exactly and a cart total can never drift from the sum of its lines.
 *
 * ── Precedence ──
 * When several sales match one product the winner is, in order:
 *   1. highest `priority`
 *   2. earliest `createdAt`  (the campaign that was set up first)
 *   3. lowest `id`           (final tie-break; ULIDs make this creation order too)
 *
 * `priority` is the ONLY business-controlled lever, deliberately. Discount SIZE
 * is not a tie-break: a PERCENT value and a FIXED value are not comparable
 * without a price (is 20% "bigger" than 50 000 so'm?), and any answer depends on
 * the product — so ranking by size would make the winning campaign vary from one
 * product to the next within a single cart. Priority is explicit, price-
 * independent and identical for every product a sale covers.
 *
 * Steps 2–3 are pure determinism, not policy: they only settle sales an operator
 * gave the same priority. To make one campaign override another, raise its
 * priority — nothing else changes the outcome.
 *
 * Discounts are never stacked. Two 20% sales give 20% off, not 36% or 40%.
 */
@Injectable()
export class DiscountService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every sale that is live right now, with its targets. Callers pricing many
   * products (a catalog page, a cart) should call this ONCE and pass the result
   * to `calculateDiscount`, which keeps an N-product page at one query rather
   * than N.
   */
  async loadActiveSales(now: Date = new Date()): Promise<ActiveSale[]> {
    return this.prisma.sale.findMany({
      where: this.activeWhere(now),
      include: { targets: { select: { targetType: true, targetId: true } } },
    });
  }

  /**
   * The Prisma filter for "active right now" — the single definition of
   * activeness, shared by this service and the public GET /v1/sales endpoint so
   * the two can never disagree about which sales are live.
   *
   * Active means: not deleted AND isActive AND startAt <= now AND
   * (endAt IS NULL OR endAt >= now).
   *
   * An EXPIRED sale (endAt in the past) needs no sweeper job to stop applying:
   * activeness is derived from the clock on every read, so the sale simply stops
   * matching the moment its window closes. Nothing has to write to the row.
   */
  activeWhere(now: Date = new Date()): Prisma.SaleWhereInput {
    return {
      deletedAt: null,
      isActive: true,
      startAt: { lte: now },
      OR: [{ endAt: null }, { endAt: { gte: now } }],
    };
  }

  /**
   * Price one product against a pre-loaded set of sales. Pure and synchronous —
   * no I/O — so it is cheap to call per line item and trivial to unit-test.
   *
   * `originalPrice` is returned unchanged, and `appliedSale` is null, when no
   * sale applies.
   */
  calculateDiscount(
    originalPrice: number,
    product: DiscountableProduct,
    sales: ActiveSale[],
  ): DiscountResult {
    const none = this.noDiscount(originalPrice);

    // A non-finite or negative price is not something to discount — return it
    // untouched rather than inventing a number.
    if (!Number.isFinite(originalPrice) || originalPrice <= 0) return none;

    const sale = this.pickBestSale(product, sales);
    if (!sale) return none;

    const discountAmount = this.discountAmountFor(sale, originalPrice);
    if (discountAmount <= 0) return none;

    const finalPrice = originalPrice - discountAmount;

    return {
      originalPrice,
      finalPrice,
      discountAmount,
      // Effective percentage actually achieved, which for a FIXED sale is
      // whatever the amount works out to. Rounded to two places for display;
      // never an input to the arithmetic above.
      discountPercent:
        Math.round((discountAmount / originalPrice) * 100 * 100) / 100,
      appliedSale: {
        id: sale.id,
        title: sale.title,
        discountType: sale.discountType,
        discountValue: sale.discountValue.toNumber(),
      },
    };
  }

  /**
   * Convenience wrapper for a single product: loads the active sales and prices
   * it in one call. Use `loadActiveSales` + `calculateDiscount` when pricing
   * more than one product, to avoid a query per item.
   */
  async calculateDiscountFor(
    originalPrice: number,
    product: DiscountableProduct,
    now: Date = new Date(),
  ): Promise<DiscountResult> {
    const sales = await this.loadActiveSales(now);
    return this.calculateDiscount(originalPrice, product, sales);
  }

  /**
   * Price many products against one snapshot of the active sales — one query
   * regardless of how many products are passed. Returns a Map keyed by product
   * id.
   */
  async calculateDiscounts(
    items: { product: DiscountableProduct; price: number }[],
    now: Date = new Date(),
  ): Promise<Map<string, DiscountResult>> {
    const sales = items.length ? await this.loadActiveSales(now) : [];
    return new Map(
      items.map((item) => [
        item.product.id,
        this.calculateDiscount(item.price, item.product, sales),
      ]),
    );
  }

  /** Does this sale target this product? */
  appliesTo(sale: ActiveSale, product: DiscountableProduct): boolean {
    if (sale.scopeType === SaleScopeType.ALL_PRODUCTS) return true;

    const matcher = SCOPE_MATCHERS[sale.scopeType];
    // An unknown scope (an enum value added to the schema before its matcher)
    // matches nothing. Fail closed: a sale nobody taught us to resolve must not
    // silently discount the whole catalog.
    if (!matcher) return false;

    const productValue = matcher(product);
    if (productValue == null) return false;

    return sale.targets.some(
      (t) => t.targetType === sale.scopeType && t.targetId === productValue,
    );
  }

  /** The untouched-price result. */
  private noDiscount(originalPrice: number): DiscountResult {
    return {
      originalPrice,
      finalPrice: originalPrice,
      discountAmount: 0,
      discountPercent: 0,
      appliedSale: null,
    };
  }

  /**
   * The winning sale among those that target this product, or null.
   * Order: priority desc, then createdAt asc, then id asc.
   *
   * Note what is NOT here: the discount value. The winner is chosen without
   * looking at how much anything costs or how deep any discount is, so the SAME
   * sale wins for every product it covers — a campaign cannot win on a cheap
   * item and lose on an expensive one in the same cart.
   */
  private pickBestSale(
    product: DiscountableProduct,
    sales: ActiveSale[],
  ): ActiveSale | null {
    let best: ActiveSale | null = null;

    for (const sale of sales) {
      if (!this.appliesTo(sale, product)) continue;
      if (!best || this.outranks(sale, best)) best = sale;
    }

    return best;
  }

  /**
   * Does `candidate` beat `incumbent`? Strict: an exact tie on all three keys is
   * false, so a stable scan keeps the first such sale and the result cannot
   * depend on the order rows came back from the database.
   */
  private outranks(candidate: ActiveSale, incumbent: ActiveSale): boolean {
    if (candidate.priority !== incumbent.priority) {
      return candidate.priority > incumbent.priority;
    }
    const byCreatedAt =
      candidate.createdAt.getTime() - incumbent.createdAt.getTime();
    if (byCreatedAt !== 0) return byCreatedAt < 0; // earlier wins
    return candidate.id < incumbent.id;
  }

  /**
   * The discount in whole UZS, clamped to [0, originalPrice] so a fixed
   * discount larger than the price yields a free item rather than a negative
   * one — the "never negative" rule, enforced here rather than at each caller.
   */
  private discountAmountFor(sale: ActiveSale, originalPrice: number): number {
    const value = sale.discountValue.toNumber();
    if (!Number.isFinite(value) || value <= 0) return 0;

    const raw =
      sale.discountType === SaleDiscountType.PERCENT
        ? (originalPrice * Math.min(value, 100)) / 100
        : value;

    // Round the DISCOUNT, so finalPrice = originalPrice - discountAmount is
    // exact in whole so'm and a total never drifts from the sum of its lines.
    return Math.min(Math.round(raw), originalPrice);
  }
}
