import { OilType, PackageForm, ProductKind } from '@prisma/client';
import {
  dealerFiscalGaps,
  FiscalCategorySource,
  resolveFiscalClassification,
} from '../../common/fiscal.util';
import { splitEvenLines } from '../promo-allocation.util';

/**
 * The Payme receipt (`detail`) shapes and the ONE mapping from an order line to
 * a fiscal item. Pure — no Prisma, no Nest — so the mapping rules are unit
 * testable on their own and the service around them only does I/O.
 *
 * Where every field comes from (nothing else is sent — see the note on `units`):
 *
 *   OrderItem ─┬─→ title, count, price (tiyin)
 *              ↓
 *          CatalogPart ─┬─→ resolveFiscalClassification ─┬─→ code (MXIK / ИКПУ)
 *                       │                                └─→ package_code
 *                       └─→ seller (dealer) ─┬─→ vat_percent
 *                                            └─→ commission_info.tin
 *
 * A sourcing-offer line reaches the same two boxes through its offer: the category
 * an operator gave it, and the dealer behind the seller who made it. A service line
 * reaches them through its offering: the category an operator gave it, and its provider.
 *
 * Per ITEM, never per order: one order may carry products from several dealers,
 * so each line is fiscalized with ITS OWN dealer's TIN and VAT rate.
 */

/**
 * What an order line IS, from what it states rather than from what it lacks. A line
 * with no part is not thereby a service: a sourcing offer is goods with no part, and
 * a line stating nothing at all is UNKNOWN, which checkout refuses.
 */
export type OrderLineType = 'PRODUCT' | 'SOURCING_OFFER' | 'SERVICE' | 'UNKNOWN';

export function orderLineType(line: {
  partId?: string | null;
  offerId?: string | null;
  serviceId?: string | null;
}): OrderLineType {
  if (line.partId) return 'PRODUCT';
  if (line.offerId) return 'SOURCING_OFFER';
  if (line.serviceId) return 'SERVICE';
  return 'UNKNOWN';
}

/** A line item of a Payme receipt, exactly as it goes on the wire. */
export interface PaymeFiscalItem {
  title: string;
  /** UNIT price in TIYIN (1 UZS = 100 tiyin), like every Payme amount. */
  price: number;
  count: number;
  /** MXIK / ИКПУ of the item's category. */
  code: string;
  /** Tasnif package code for the form this listing is sold in. */
  package_code: string;
  /** The dealer's VAT rate, as a percentage. */
  vat_percent: number;
  /**
   * The dealer's own tax id, so each line settles to the right merchant.
   *
   * OPTIONAL, and present on every PRODUCT line: a platform line (delivery, the
   * service fee) is the marketplace's own service, so it carries the
   * marketplace TIN when one is configured and omits the field entirely when
   * not — an empty or borrowed TIN on a platform line would attribute the
   * marketplace's revenue to a dealer.
   */
  commission_info?: { tin: string };
}

/**
 * `units` is DELIBERATELY absent. Payme's CheckPerformTransaction table marks
 * `package_code` required and `units` optional, and Tasnif states the form an item is
 * sold in through its package codes: on the MXIK codes we use, its unit fields are
 * empty. A field is never invented here to fill a shape.
 */
export interface PaymeReceiptDetail {
  /** 0 = sale — the only receipt type this integration produces. */
  receipt_type: number;
  items: PaymeFiscalItem[];
}

/** Payme's receipt type for an ordinary sale. */
export const PAYME_RECEIPT_TYPE_SALE = 0;

/** Everything one order line needs to be fiscalized, already loaded. */
export interface FiscalLineSource {
  /** For error reporting only — never sent to Payme. */
  reference: string;
  title: string;
  quantity: number;
  /** Unit price in UZS, as charged on the order line. */
  priceUzs: number;
  /**
   * The line's TOTAL in UZS, as charged — the authority for what this line
   * contributes to the receipt.
   *
   * Present because a promo discount is embedded in the line prices (see
   * promo-allocation.util), and a discounted multi-unit line's total need not
   * divide evenly by its count: `priceUzs × quantity` can then fall a few tiyin
   * short. Fiscalizing off the total instead keeps the receipt reconciling
   * exactly. Optional — a line without it falls back to price × quantity, which
   * is the same number for every undiscounted line.
   */
  lineTotalUzs?: number;
  /** The category the item is filed on, or null when that is unknown. */
  category: FiscalCategorySource | null;
  /** The sale form stated for the listing; null when nobody was asked. */
  packageForm: PackageForm | null;
  /** The listing's kind and oil type, for resolveFiscalClassification. */
  kind: ProductKind;
  oilType: OilType | null;
  /** The dealer's tax data, or null when the part is gone. */
  dealer: { tin: string | null; vatPercent: number | null } | null;
}

/** A non-product charge on the order that must appear on the receipt. */
export interface FiscalFeeSource {
  /** For error reporting only — never sent to Payme. */
  reference: string;
  title: string;
  /** The charge in UZS. */
  amountUzs: number;
  /** The platform's codes for this charge (see PaymeFiscalConfig). */
  codes: { mxik: string | null; packageCode: string | null };
  /** Null when no valid rate is configured, which refuses the line. */
  vatPercent: number | null;
  /** The MARKETPLACE's tax id, or null to omit commission_info entirely. */
  marketplaceTin: string | null;
}

/**
 * A mapped line, or the reasons it could not be mapped.
 *
 * `items` is a LIST because one order line can need more than one receipt line:
 * a discounted multi-unit line whose total does not divide evenly by its count
 * is split so that `SUM(price × count)` still lands on the charged amount
 * exactly (see splitEvenLines). Undiscounted lines yield exactly one item.
 */
export type FiscalLineResult =
  { ok: true; items: PaymeFiscalItem[] } | { ok: false; gaps: string[] };

/**
 * Map one order line to its fiscal item, or report exactly what is missing.
 *
 * A line is only fiscalizable when the classification resolves (a confirmed MXIK and
 * package code of its own) and the dealer's TIN and VAT rate are present. Missing
 * data is reported — never substituted — because every plausible default here is a
 * lie to the tax authority: an absent VAT rate is not 0%, and an absent MXIK has no
 * stand-in.
 */
export function buildFiscalItem(line: FiscalLineSource): FiscalLineResult {
  const classification = resolveFiscalClassification(line);
  const gaps = [
    ...(classification.ok ? [] : classification.gaps),
    ...dealerFiscalGaps(line.dealer),
  ];

  if (!classification.ok || gaps.length > 0) {
    return { ok: false, gaps: gaps.map((g) => `${line.reference}: ${g}`) };
  }
  const { mxik, packageCode } = classification;
  const tin = line.dealer?.tin;
  const vatPercent = line.dealer?.vatPercent;

  // Tiyin, rounded the same way the payable amount is (Math.round on UZS × 100),
  // so a receipt line can never disagree with the charge. The LINE TOTAL is what
  // gets split into receipt lines — see FiscalLineSource.lineTotalUzs for why it
  // is the authority rather than price × quantity.
  const lineTotalTiyin = Math.round(
    (line.lineTotalUzs ?? line.priceUzs * line.quantity) * 100,
  );

  return {
    ok: true,
    items: splitEvenLines(lineTotalTiyin, line.quantity).map((split) => ({
      title: line.title,
      price: split.unitPriceTiyin,
      count: split.count,
      code: mxik,
      package_code: packageCode,
      vat_percent: vatPercent as number,
      commission_info: { tin: tin as string },
    })),
  };
}

/**
 * Map a non-product charge (delivery, the service fee) to its receipt line.
 *
 * Payme reconciles a receipt against the amount actually charged, so every
 * component of the order total needs a line — a receipt listing only the goods
 * is short by exactly the fees. These lines are the PLATFORM's, not a dealer's:
 * delivery has a fixed system code, the service fee's comes from configuration, and
 * their `commission_info` is the marketplace's TIN, omitted entirely when none is
 * configured.
 *
 * Reports a gap instead of guessing when a code or the VAT rate is unset: a charge
 * fiscalized under a code that describes something else, or a rate nobody stated, is
 * worse than a refused checkout.
 */
export function buildFeeItem(fee: FiscalFeeSource): FiscalLineResult {
  const gaps: string[] = [];
  if (!fee.codes.mxik) gaps.push(`${fee.reference}: no MXIK is configured`);
  if (!fee.codes.packageCode) {
    gaps.push(`${fee.reference}: no package code is configured`);
  }
  if (fee.vatPercent === null) {
    gaps.push(`${fee.reference}: no valid VAT percentage is configured`);
  }
  if (gaps.length > 0) return { ok: false, gaps };

  return {
    ok: true,
    // Always exactly one line: a fee is a single charge of count 1, so it has no
    // per-unit remainder to split.
    items: [{
      title: fee.title,
      // The whole charge is one line of count 1 — a fee has no unit price.
      price: Math.round(fee.amountUzs * 100),
      count: 1,
      code: fee.codes.mxik as string,
      package_code: fee.codes.packageCode as string,
      vat_percent: fee.vatPercent as number,
      // Omitted (not blanked) when the platform has no TIN configured: Payme
      // then attributes the line to the merchant account itself.
      ...(fee.marketplaceTin
        ? { commission_info: { tin: fee.marketplaceTin } }
        : {}),
    }],
  };
}

/** What the receipt's lines add up to, in tiyin — Payme's own arithmetic. */
export function receiptTotalTiyin(items: PaymeFiscalItem[]): number {
  return items.reduce((sum, item) => sum + item.price * item.count, 0);
}
