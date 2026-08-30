import { OilType, PackageForm, ProductKind } from '@prisma/client';
import {
  CategoryFiscalData,
  OIL_TYPE_REQUIRED,
  resolveOilFiscalCodes,
  resolvePackageCode,
} from '../../common/fiscal.util';
import { fiscalizedByOilType } from '../../common/product-kind';
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
 *          CatalogPart ─┬─→ category ──→ code         (MXIK / ИКПУ)
 *                       │            └─→ package_code (Tasnif, by sale form)
 *                       └─→ seller (dealer) ─┬─→ vat_percent
 *                                            └─→ commission_info.tin
 *
 * Per ITEM, never per order: one order may carry products from several dealers,
 * so each line is fiscalized with ITS OWN dealer's TIN and VAT rate.
 */

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
 * `units` is DELIBERATELY absent. The integration sends the Tasnif package code
 * (`package_code`) as the unit-of-sale, which is what the current Payme fiscal
 * contract asks for; nothing in that contract requires `units` alongside it, and
 * a field is never invented here to fill a shape.
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
  /** The item's category fiscal data, or null when the part is gone. */
  category: CategoryFiscalData | null;
  /** The sale form chosen for the listing; null ⇒ the single package code. */
  packageForm: PackageForm | null;
  /**
   * The listing's kind. It decides WHERE the codes come from: a kind whose
   * capability entry says `fiscalizedByOilType` (motor oil) reads `oilType`,
   * because the registry classifies oil by base composition; every other kind —
   * ANTIFREEZE included — reads its own category's columns.
   */
  kind: ProductKind;
  /** Base composition of a motor oil; null for every other kind. */
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
  /** The platform's codes for this charge (see readPaymeFiscalConfig). */
  codes: { mxik: string | null; packageCode: string | null };
  vatPercent: number;
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
 * A line is only fiscalizable when all four facts are present: MXIK, a package
 * code, the dealer's TIN and the dealer's VAT rate. Missing data is reported —
 * never substituted — because every plausible default here is a lie to the tax
 * authority: an absent VAT rate is not 0%, and an absent MXIK has no stand-in.
 */
export function buildFiscalItem(line: FiscalLineSource): FiscalLineResult {
  const gaps: string[] = [];

  // WHERE the codes come from is decided by the listing, not by the caller:
  // motor oil is classified by base composition (three MXIKs under one
  // category), everything else by its category. The rule is read from the kind
  // capability table, so it is stated once and shared with the wizard and the
  // admin console rather than re-derived here as a `kind === MOTOR_OIL` check.
  //
  // The second clause is the long-standing defensive one: a SPARE_PART carrying
  // an oil type is an oil however it was classified, and fiscalizing it off an
  // unrelated category's code would be wrong. (`!= null`, so an absent field
  // reads like a null one instead of sending every product down the oil path.)
  // It is deliberately NOT extended to a kind that has its own fiscal taxonomy:
  // ANTIFREEZE must keep its OWN category's IKPU, and a stray oilType on such a
  // row must never divert it onto a motor-oil code.
  const byOilType =
    fiscalizedByOilType(line.kind) ||
    (line.kind === ProductKind.SPARE_PART && line.oilType != null);

  let mxik: string | null;
  let packageCode: string | null;
  if (byOilType) {
    const oil = resolveOilFiscalCodes(line.oilType);
    mxik = oil?.mxik ?? null;
    packageCode = oil?.packageCode ?? null;
    if (!oil) gaps.push(OIL_TYPE_REQUIRED);
  } else {
    mxik = line.category?.mxik ?? null;
    packageCode = line.category
      ? resolvePackageCode(line.category, line.packageForm)
      : null;
    if (!line.category) gaps.push('category fiscal data is unavailable');
    if (!mxik) gaps.push('category has no MXIK');
    if (!packageCode) gaps.push('category has no package code');
  }

  const tin = line.dealer?.tin ?? null;
  const vatPercent = line.dealer?.vatPercent ?? null;

  if (!line.dealer) gaps.push('dealer is unavailable');
  else {
    if (!tin) gaps.push('dealer has no TIN');
    if (vatPercent === null) gaps.push('dealer has no VAT percentage');
  }

  if (gaps.length > 0) {
    return { ok: false, gaps: gaps.map((g) => `${line.reference}: ${g}`) };
  }

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
      code: mxik as string,
      package_code: packageCode as string,
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
 * their codes come from configuration and their `commission_info` is the
 * marketplace's TIN, omitted entirely when none is configured.
 *
 * Reports a gap instead of guessing when the codes are unset — a charge
 * fiscalized under a code that describes something else is worse than a refused
 * checkout, and the operator only has to set two environment variables.
 */
export function buildFeeItem(fee: FiscalFeeSource): FiscalLineResult {
  const gaps: string[] = [];
  if (!fee.codes.mxik) gaps.push(`${fee.reference}: no MXIK is configured`);
  if (!fee.codes.packageCode) {
    gaps.push(`${fee.reference}: no package code is configured`);
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
      vat_percent: fee.vatPercent,
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
