import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, ProductKind } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { readPaymeFiscalConfig } from './payme.config';
import {
  buildFeeItem,
  buildFiscalItem,
  FiscalFeeSource,
  FiscalLineSource,
  PAYME_RECEIPT_TYPE_SALE,
  PaymeFiscalItem,
  PaymeReceiptDetail,
  receiptTotalTiyin,
} from './payme-fiscal.util';

/** Receipt titles for the platform's own charges. */
export const DELIVERY_TITLE = 'Услуга доставки';
export const SERVICE_FEE_TITLE = 'Сервисный сбор';

/**
 * A checkout was attempted for an order whose fiscal data is not complete —
 * most often a dealer whose ИНН / ставка НДС an operator has not entered yet.
 *
 * Named for the FAILURE, not for one of its causes: the same refusal covers a
 * category that has no MXIK, since both end the same way — an order that must
 * not reach Payme. The message is the customer-facing one; the specific gaps
 * are logged for operators rather than exposed, because they describe internal
 * configuration.
 *
 * A BadRequest (400), matching the neighbouring "Order is not awaiting payment"
 * refusal in PaymentsService — the request is well-formed, the order's state is
 * what makes it unpayable right now.
 */
export class FiscalDataIncompleteException extends BadRequestException {
  constructor(readonly gaps: string[]) {
    super(
      'Product is temporarily unavailable for online payment until seller ' +
        'verification is complete',
    );
  }
}

/**
 * Builds the fiscal `detail` Payme receives for an order, and is the GATE that
 * keeps an incompletely-configured order away from Payme entirely.
 *
 * The data is assembled per ITEM from the buyer-side read model, which is where
 * an order's `partId` points:
 *
 *   OrderItem.partId → CatalogPart ─┬→ category  (mxik, package codes)
 *                                   └→ seller    (dealer: tin, vatPercent)
 *
 * Nothing fiscal is read off the order or copied onto it. That is the whole
 * point of holding this data on the category and the dealer: an operator who
 * fills in a dealer's tax data, or corrects a category's MXIK, makes every
 * existing product of theirs fiscally valid at once — no product row is
 * rewritten and no order is migrated.
 */
@Injectable()
export class PaymeFiscalService {
  private readonly logger = new Logger(PaymeFiscalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * The receipt detail for an order, or null when there is nothing to fiscalize.
   *
   * Null (rather than an empty receipt) is returned for an order with no
   * PRODUCT lines — a services-only order, whose lines reference a provider
   * offering and no catalog part. Such an order carries no MXIK-bearing item,
   * so it is left exactly as it was before fiscalization existed instead of
   * being blocked by it.
   *
   * @throws FiscalDataIncompleteException when a product line cannot be
   * fiscalized — the caller must let it propagate: a malformed or partial
   * receipt must never be sent.
   */
  async buildOrderDetail(orderId: string): Promise<PaymeReceiptDetail | null> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        totalUzs: true,
        deliveryUzs: true,
        serviceFeeUzs: true,
        discountUzs: true,
      },
    });
    if (!order) return null;

    const lines = await this.loadLines(orderId);
    if (lines.length === 0) return null;

    const items: PaymeFiscalItem[] = [];
    const gaps: string[] = [];
    for (const line of lines) {
      const result = buildFiscalItem(line);
      if (result.ok) items.push(...result.items);
      else gaps.push(...result.gaps);
    }

    // The platform's own charges. They are part of what the customer pays, so
    // they are part of the receipt — Payme reconciles the two.
    for (const fee of this.orderFees(order)) {
      const result = buildFeeItem(fee);
      if (result.ok) items.push(...result.items);
      else gaps.push(...result.gaps);
    }

    if (gaps.length === 0) {
      // Last check, and the one Payme itself performs: the lines must add up to
      // the amount charged. Anything left over means a component of the total
      // has no line (see orderFees) — reported here rather than discovered as a
      // provider-side rejection after the customer has tapped Pay.
      const residual = this.reconcile(order, items);
      if (residual) gaps.push(residual);
    }

    if (gaps.length > 0) {
      // Logged, not returned: the gaps name internal configuration (which
      // dealer, which category), while the customer only learns the item is
      // not payable yet.
      this.logger.warn(
        `Order ${orderId} cannot be fiscalized — ${gaps.join('; ')}`,
      );
      throw new FiscalDataIncompleteException(gaps);
    }

    return { receipt_type: PAYME_RECEIPT_TYPE_SALE, items };
  }

  /**
   * The non-product charges on an order, in receipt order. Only charges the
   * order actually carries produce a line: a pickup order (no delivery fee) and
   * a fee-free order get no extra lines at all, so their receipts are exactly
   * what they were before.
   *
   * A promo DISCOUNT is deliberately absent, and needs no line: it is spread
   * into the item prices when the order is created (promo-allocation.util), so
   * by the time a receipt is built the discount is already inside the goods and
   * the fiscal discount is, correctly, zero. Payme has no negative item, which
   * is exactly why the discount is embedded rather than represented here.
   */
  private orderFees(order: {
    deliveryUzs: Prisma.Decimal;
    serviceFeeUzs: Prisma.Decimal;
  }): FiscalFeeSource[] {
    const fiscal = readPaymeFiscalConfig((key) => this.config.get<string>(key));
    const fees: FiscalFeeSource[] = [];

    const deliveryUzs = Number(order.deliveryUzs);
    if (deliveryUzs > 0) {
      fees.push({
        reference: 'delivery fee (set DELIVERY_MXIK / DELIVERY_PACKAGE_CODE)',
        title: DELIVERY_TITLE,
        amountUzs: deliveryUzs,
        codes: fiscal.delivery,
        vatPercent: fiscal.delivery.vatPercent,
        marketplaceTin: fiscal.marketplaceTin,
      });
    }

    const serviceFeeUzs = Number(order.serviceFeeUzs);
    if (serviceFeeUzs > 0) {
      fees.push({
        reference:
          'service fee (set SERVICE_FEE_MXIK / SERVICE_FEE_PACKAGE_CODE)',
        title: SERVICE_FEE_TITLE,
        amountUzs: serviceFeeUzs,
        codes: fiscal.serviceFee,
        vatPercent: fiscal.serviceFee.vatPercent,
        marketplaceTin: fiscal.marketplaceTin,
      });
    }

    return fees;
  }

  /**
   * Compare the receipt with the charge — the equality Payme itself enforces.
   * Returns null when they agree, else a message naming the shortfall.
   *
   * A promo discount is no longer a cause of failure here: it is embedded in the
   * item prices at order creation, so a discounted order's lines already sum to
   * the discounted charge. What remains catchable is a genuine defect — a
   * component of the total with no line at all, or an order whose stored total
   * disagrees with its own items.
   */
  private reconcile(
    order: { totalUzs: Prisma.Decimal },
    items: PaymeFiscalItem[],
  ): string | null {
    // The same rounding the payable amount uses (PaymentsService, and the
    // webhook's own amount check), so the two can never disagree by a tiyin.
    const chargedTiyin = Math.round(Number(order.totalUzs) * 100);
    const receiptTiyin = receiptTotalTiyin(items);
    if (receiptTiyin === chargedTiyin) return null;

    return (
      `receipt total ${receiptTiyin} tiyin does not match the charged ` +
      `${chargedTiyin} tiyin`
    );
  }

  /**
   * Assert an order is fiscalizable without keeping the receipt — used by the
   * checkout path, which only needs the refusal. Same rules, same exception, so
   * an order that passes here cannot fail when the webhook builds the receipt.
   */
  async assertFiscalizable(orderId: string): Promise<void> {
    await this.buildOrderDetail(orderId);
  }

  /**
   * Load one fiscal source per PRODUCT line of the order.
   *
   * Two reads, not one per line: the items, then every referenced CatalogPart
   * with its category and seller in a single query. A missing part (the catalog
   * row was deleted after the order was placed — OrderItem is a snapshot with
   * no FK) yields a line with null category/dealer, which the builder reports
   * as a gap rather than silently skipping: a receipt that quietly omits a
   * charged line is exactly the malformed data this gate exists to prevent.
   */
  private async loadLines(orderId: string): Promise<FiscalLineSource[]> {
    const items = await this.prisma.orderItem.findMany({
      where: { orderId, partId: { not: null } },
      select: {
        id: true,
        partId: true,
        title: true,
        quantity: true,
        priceUzs: true,
        lineTotalUzs: true,
      },
    });
    if (items.length === 0) return [];

    const parts = await this.prisma.catalogPart.findMany({
      where: { id: { in: items.map((i) => i.partId as string) } },
      select: {
        id: true,
        packageForm: true,
        // Kind + oil type: a motor oil's codes come from its base composition,
        // not from its category. Both are already projected onto CatalogPart by
        // CatalogProjectionService, so this needs no extra join back into the
        // seller domain.
        kind: true,
        oilType: true,
        category: {
          select: {
            mxik: true,
            packageCodeSingle: true,
            packageCodeSet: true,
          },
        },
        seller: { select: { tin: true, vatPercent: true } },
      },
    });
    const byId = new Map(parts.map((p) => [p.id, p]));

    return items.map((item) => {
      const part = byId.get(item.partId as string);
      return {
        reference: `item ${item.id} (part ${item.partId})`,
        title: item.title,
        quantity: item.quantity,
        priceUzs: Number(item.priceUzs),
        // The charged line total, which is what the receipt must reconcile to.
        // Falls back to price × quantity for a line stored before the total was
        // recorded, where the two are equal anyway.
        lineTotalUzs:
          item.lineTotalUzs == null
            ? undefined
            : Number(item.lineTotalUzs),
        category: part?.category ?? null,
        packageForm: part?.packageForm ?? null,
        // A missing part is reported as a gap by the builder anyway; the kind
        // defaults to the category path so the message names the category
        // rather than blaming a missing oil type.
        kind: part?.kind ?? ProductKind.SPARE_PART,
        oilType: part?.oilType ?? null,
        // Decimal → number at the boundary: `vat_percent` goes on the wire as a
        // JSON number, and a Prisma Decimal does not serialize as one.
        dealer: part
          ? {
              tin: part.seller.tin,
              vatPercent:
                part.seller.vatPercent === null
                  ? null
                  : Number(part.seller.vatPercent),
            }
          : null,
      };
    });
  }
}
