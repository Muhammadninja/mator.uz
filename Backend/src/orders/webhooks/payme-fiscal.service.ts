import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeliveryMethod, Prisma, ProductKind } from '@prisma/client';
import { listingTypeForCategory } from '../../catalog/categories/category-map';
import { CatalogProjectionService } from '../../catalog/projection/catalog-projection.service';
import { FISCAL_CATEGORY_SELECT } from '../../common/fiscal.util';
import { PrismaService } from '../../prisma/prisma.service';
import { DELIVERY_COST_UNAVAILABLE } from '../order-availability';
import { readPaymeFiscalConfig } from './payme.config';
import {
  buildFeeItem,
  buildFiscalItem,
  FiscalFeeSource,
  FiscalLineSource,
  orderLineType,
  PAYME_RECEIPT_TYPE_SALE,
  PaymeFiscalItem,
  PaymeReceiptDetail,
  receiptTotalTiyin,
} from './payme-fiscal.util';

/** Receipt titles for the platform's own charges. */
export const DELIVERY_TITLE = 'Доставка';
export const SERVICE_FEE_TITLE = 'Сервисный сбор';

/** What a client can tell this refusal by, apart from any other 400. */
export const FISCAL_DATA_INCOMPLETE = 'FISCAL_DATA_INCOMPLETE';

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
  constructor(
    readonly gaps: string[],
    response: { code: string; message: string } = {
      code: FISCAL_DATA_INCOMPLETE,
      message:
        'Product is temporarily unavailable for online payment until seller ' +
        'verification is complete',
    },
  ) {
    super(response);
  }
}

/** What the customer hears when the delivery cost is what stops the payment. */
const DELIVERY_COST_REFUSAL = {
  code: DELIVERY_COST_UNAVAILABLE,
  message:
    'The delivery cost of this order is not available, so it cannot be paid online yet.',
};

/** The order-line columns the receipt reads. */
const FISCAL_ORDER_ITEM_SELECT = {
  id: true,
  partId: true,
  offerId: true,
  offerSellerTgId: true,
  serviceId: true,
  title: true,
  quantity: true,
  priceUzs: true,
  lineTotalUzs: true,
} satisfies Prisma.OrderItemSelect;

type FiscalOrderItem = Prisma.OrderItemGetPayload<{
  select: typeof FISCAL_ORDER_ITEM_SELECT;
}>;

/** The fiscal part of one source line: everything but the amounts and title. */
type LineClassification = Pick<
  FiscalLineSource,
  'reference' | 'category' | 'packageForm' | 'kind' | 'oilType' | 'dealer'
>;

/**
 * What is wrong with an order's stored delivery cost, or null. Only ever the stored
 * value: it is what the customer agreed to and what the total holds, so nothing fetches
 * a newer figure while a payment is under way. Goods sent by courier cannot go without
 * a cost, because a free courier is not something an order can state: 0 is what is
 * stored when no cost is known.
 */
function deliveryCostProblem(
  order: { deliveryMethod?: DeliveryMethod | null; deliveryUzs: unknown },
  hasGoods: boolean,
): string | null {
  const amount = Number(order.deliveryUzs);
  if (order.deliveryUzs == null || !Number.isFinite(amount) || amount < 0) {
    return 'the delivery cost stored on the order is invalid';
  }
  if (
    order.deliveryMethod === DeliveryMethod.COURIER &&
    hasGoods &&
    amount === 0
  ) {
    return 'the order is for courier delivery and holds no delivery cost';
  }
  if (order.deliveryMethod === DeliveryMethod.PICKUP && amount > 0) {
    return 'the order is for pickup and holds a delivery cost';
  }
  return null;
}

/** Decimal → number at the boundary: `vat_percent` goes on the wire as a number. */
function dealerTaxData(dealer: {
  tin: string | null;
  vatPercent: Prisma.Decimal | null;
}): { tin: string | null; vatPercent: number | null } {
  return {
    tin: dealer.tin,
    vatPercent: dealer.vatPercent === null ? null : Number(dealer.vatPercent),
  };
}

/**
 * Builds the fiscal `detail` Payme receives for an order, and is the GATE that
 * keeps an incompletely-configured order away from Payme entirely.
 *
 * The data is assembled per ITEM from the buyer-side read model:
 *
 *   OrderItem.partId  → CatalogPart ───┬→ category  (mxik, package codes)
 *                                      └→ seller    (dealer: tin, vatPercent)
 *   OrderItem.offerId → SourcingOffer ───→ category  (set by an operator)
 *   OrderItem.offerSellerTgId → Seller ──→ dealer    (tin, vatPercent)
 *   OrderItem.serviceId → ProviderServiceOffering ─┬→ category
 *                                                  └→ provider (tin, vatPercent)
 *
 * Nothing fiscal is read off the order or copied onto it. That is the whole
 * point of holding this data on the category and the dealer: an operator who
 * fills in a dealer's tax data, or corrects a category's MXIK, makes every
 * existing product of theirs fiscally valid at once — no product row is
 * rewritten and no order is migrated.
 *
 * The one copy is made when a Payme invoice is created, from what this returns (see
 * PaymeFiscalSnapshot and PaymentsService.createPaymeInvoice). From then on Payme hears
 * that copy, so a correction applies to the invoices issued after it.
 */
@Injectable()
export class PaymeFiscalService implements OnModuleInit {
  private readonly logger = new Logger(PaymeFiscalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Say so at boot, rather than when a customer's payment is refused. Only a warning:
   * pickup orders need none of this.
   */
  onModuleInit(): void {
    const { marketplaceTin } = readPaymeFiscalConfig((key) =>
      this.config.get<string>(key),
    );
    if (marketplaceTin === null) {
      this.logger.warn(
        "MARKETPLACE_TIN is unset or cannot be Mator's 9-digit tax id: any order with " +
          'a delivery cost will be refused until it is configured.',
      );
    }
  }

  /**
   * The receipt detail for an order. Every line and every charge is on it or the order
   * is refused, whatever kind of order it is: there is no path that lets one through
   * with no receipt.
   *
   * An order of services alone is refused as a TYPE unless an operator has allowed it.
   * That allowance lifts only this refusal. Its lines then face the same rules as goods,
   * so it cannot wave through a line with no classification, and a line stating nothing
   * at all is refused whatever it says.
   *
   * @throws FiscalDataIncompleteException when any line cannot be fiscalized — the
   * caller must let it propagate: a malformed or partial receipt must never be sent.
   */
  async buildOrderDetail(orderId: string): Promise<PaymeReceiptDetail> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        totalUzs: true,
        deliveryMethod: true,
        deliveryUzs: true,
        serviceFeeUzs: true,
        discountUzs: true,
      },
    });
    if (!order) this.refuse(orderId, ['the order does not exist']);

    const rows = await this.prisma.orderItem.findMany({
      where: { orderId },
      select: FISCAL_ORDER_ITEM_SELECT,
    });
    if (rows.length === 0) this.refuse(orderId, ['the order has no lines']);

    if (rows.every((row) => orderLineType(row) === 'SERVICE')) {
      const fiscal = readPaymeFiscalConfig((key) =>
        this.config.get<string>(key),
      );
      if (!fiscal.allowServiceOnlyOrders) {
        this.refuse(orderId, [
          'an order of services alone cannot be paid online (PAYME_ALLOW_SERVICE_ONLY_ORDERS is off)',
        ]);
      }
    }

    const deliveryProblem = deliveryCostProblem(
      order,
      rows.some((row) => {
        const type = orderLineType(row);
        return type === 'PRODUCT' || type === 'SOURCING_OFFER';
      }),
    );
    if (deliveryProblem) {
      this.refuse(orderId, [deliveryProblem], DELIVERY_COST_REFUSAL);
    }

    const items: PaymeFiscalItem[] = [];
    const gaps: string[] = [];
    const classified = await this.classifyLines(rows);
    for (const row of rows) {
      const line = classified.get(row.id);
      if (!line) {
        gaps.push(`item ${row.id}: the line states no part, offer or service`);
        continue;
      }
      const result = buildFiscalItem({
        ...line,
        title: row.title,
        quantity: row.quantity,
        priceUzs: Number(row.priceUzs),
        // The charged line total, which is what the receipt must reconcile to.
        // Falls back to price × quantity for a line stored before the total was
        // recorded, where the two are equal anyway.
        lineTotalUzs:
          row.lineTotalUzs == null ? undefined : Number(row.lineTotalUzs),
      });
      if (result.ok) items.push(...result.items);
      else gaps.push(...result.gaps);
    }

    // The platform's own charges. They are part of what the customer pays, so
    // they are part of the receipt — Payme reconciles the two.
    for (const fee of this.orderFees(order, items)) {
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

    if (gaps.length > 0) this.refuse(orderId, gaps);

    return { receipt_type: PAYME_RECEIPT_TYPE_SALE, items };
  }

  /**
   * Refuse the order. Logged, not returned: the gaps name internal configuration
   * (which dealer, which category), while the customer only learns the item is not
   * payable yet.
   */
  private refuse(
    orderId: string,
    gaps: string[],
    response?: { code: string; message: string },
  ): never {
    this.logger.warn(
      `Order ${orderId} cannot be fiscalized — ${gaps.join('; ')}`,
    );
    throw new FiscalDataIncompleteException(gaps, response);
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
  private orderFees(
    order: {
      deliveryUzs: Prisma.Decimal;
      serviceFeeUzs: Prisma.Decimal;
    },
    lines: PaymeFiscalItem[],
  ): FiscalFeeSource[] {
    const fiscal = readPaymeFiscalConfig((key) => this.config.get<string>(key));
    const fees: FiscalFeeSource[] = [];

    // One line per charge: a line already coded as delivery IS that charge. An order
    // that charged for it on top of that no longer adds up, and reconcile refuses it.
    const deliveryUzs = Number(order.deliveryUzs);
    const alreadyOnReceipt = lines.some(
      (line) => line.code === fiscal.delivery.mxik,
    );
    if (deliveryUzs > 0 && !alreadyOnReceipt) {
      fees.push({
        reference: 'delivery fee',
        title: DELIVERY_TITLE,
        amountUzs: deliveryUzs,
        codes: fiscal.delivery,
        vatPercent: fiscal.delivery.vatPercent,
        marketplaceTin: fiscal.marketplaceTin,
        tinRequired: true,
      });
    }

    // New orders hold no service fee. One placed earlier still has it in its total, so
    // it needs a line or a refusal, and a stored charge is never simply dropped.
    const serviceFeeUzs = Number(order.serviceFeeUzs);
    if (serviceFeeUzs > 0) {
      fees.push({
        reference:
          'service fee (set SERVICE_FEE_MXIK / SERVICE_FEE_PACKAGE_CODE / SERVICE_FEE_VAT_PERCENT)',
        title: SERVICE_FEE_TITLE,
        amountUzs: serviceFeeUzs,
        codes: fiscal.serviceFee,
        vatPercent: fiscal.serviceFee.vatPercent,
        marketplaceTin: fiscal.marketplaceTin,
        tinRequired: false,
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
   * The fiscal source of every line that states what it is, by order-item id. A line
   * stating nothing gets no entry, which the caller reports as a gap. Reads scale with
   * the order, not with its lines: one query per kind of source.
   */
  private async classifyLines(
    rows: FiscalOrderItem[],
  ): Promise<Map<string, LineClassification>> {
    const out = new Map<string, LineClassification>();
    await this.classifyProductLines(
      rows.filter((row) => orderLineType(row) === 'PRODUCT'),
      out,
    );
    await this.classifyOfferLines(
      rows.filter((row) => orderLineType(row) === 'SOURCING_OFFER'),
      out,
    );
    await this.classifyServiceLines(
      rows.filter((row) => orderLineType(row) === 'SERVICE'),
      out,
    );
    return out;
  }

  /**
   * Catalog lines. A missing part (the catalog row was deleted after the order was
   * placed — OrderItem is a snapshot with no FK) yields a line with null
   * category/dealer, which the builder reports as a gap rather than silently
   * skipping: a receipt that quietly omits a charged line is exactly the malformed
   * data this gate exists to prevent.
   */
  private async classifyProductLines(
    rows: FiscalOrderItem[],
    out: Map<string, LineClassification>,
  ): Promise<void> {
    if (rows.length === 0) return;
    const parts = await this.prisma.catalogPart.findMany({
      where: { id: { in: rows.map((row) => row.partId as string) } },
      select: {
        id: true,
        packageForm: true,
        // Both are already projected onto CatalogPart by CatalogProjectionService,
        // so this needs no extra join back into the seller domain.
        kind: true,
        oilType: true,
        category: { select: FISCAL_CATEGORY_SELECT },
        seller: { select: { tin: true, vatPercent: true } },
      },
    });
    const byId = new Map(parts.map((part) => [part.id, part]));

    for (const row of rows) {
      const part = byId.get(row.partId as string);
      out.set(row.id, {
        reference: `item ${row.id} (part ${row.partId})`,
        category: part?.category ?? null,
        packageForm: part?.packageForm ?? null,
        kind: part?.kind ?? ProductKind.SPARE_PART,
        oilType: part?.oilType ?? null,
        dealer: part ? dealerTaxData(part.seller) : null,
      });
    }
  }

  /**
   * Sourcing-offer lines: goods with no catalog part. The category is the one an
   * operator gave the offer, and the kind and oil type follow from it. The dealer is
   * whichever storefront the seller who made the offer projects into, so its tax data
   * is entered once. Whatever cannot be found stays null and is refused downstream:
   * no code or tax id is ever made up for an offer.
   */
  private async classifyOfferLines(
    rows: FiscalOrderItem[],
    out: Map<string, LineClassification>,
  ): Promise<void> {
    if (rows.length === 0) return;
    const offers = await this.prisma.sourcingOffer.findMany({
      where: { id: { in: rows.map((row) => row.offerId as string) } },
      select: {
        id: true,
        packageForm: true,
        category: { select: FISCAL_CATEGORY_SELECT },
      },
    });
    const offerById = new Map(offers.map((offer) => [offer.id, offer]));
    const dealerByTgId = await this.dealersOfSellers(
      rows.map((row) => row.offerSellerTgId),
    );

    for (const row of rows) {
      const offer = offerById.get(row.offerId as string);
      const dealer = row.offerSellerTgId
        ? dealerByTgId.get(row.offerSellerTgId)
        : undefined;
      const category = offer?.category ?? null;
      out.set(row.id, {
        reference: `item ${row.id} (sourcing offer ${row.offerId})`,
        category,
        packageForm: offer?.packageForm ?? null,
        ...(category
          ? listingTypeForCategory(category.id)
          : { kind: ProductKind.SPARE_PART, oilType: null }),
        dealer: dealer ?? null,
      });
    }
  }

  /**
   * Service lines: the category an operator gave the service, and the tax data of the
   * provider who performs it. Whatever cannot be found stays null and is refused
   * downstream, so a service with no classification never reaches a receipt.
   */
  private async classifyServiceLines(
    rows: FiscalOrderItem[],
    out: Map<string, LineClassification>,
  ): Promise<void> {
    if (rows.length === 0) return;
    const offerings = await this.prisma.providerServiceOffering.findMany({
      where: { id: { in: rows.map((row) => row.serviceId as string) } },
      select: {
        id: true,
        category: { select: FISCAL_CATEGORY_SELECT },
        provider: { select: { tin: true, vatPercent: true } },
      },
    });
    const byId = new Map(offerings.map((offering) => [offering.id, offering]));

    for (const row of rows) {
      const offering = byId.get(row.serviceId as string);
      const category = offering?.category ?? null;
      out.set(row.id, {
        reference: `item ${row.id} (service ${row.serviceId})`,
        category,
        packageForm: null,
        ...(category
          ? listingTypeForCategory(category.id)
          : { kind: ProductKind.SPARE_PART, oilType: null }),
        dealer: offering ? dealerTaxData(offering.provider) : null,
      });
    }
  }

  /** Telegram id → the tax data of the storefront that seller projects into. */
  private async dealersOfSellers(
    sellerTgIds: (string | null)[],
  ): Promise<Map<string, { tin: string | null; vatPercent: number | null }>> {
    const tgIds = [
      ...new Set(sellerTgIds.filter((id): id is string => /^\d+$/.test(id ?? ''))),
    ];
    if (tgIds.length === 0) return new Map();

    const sellers = await this.prisma.seller.findMany({
      where: { tgId: { in: tgIds.map((id) => BigInt(id)) } },
      select: { id: true, tgId: true, catalogSellerId: true },
    });
    const dealers = await this.prisma.catalogSeller.findMany({
      where: {
        id: { in: sellers.map(CatalogProjectionService.catalogSellerIdFor) },
      },
      select: { id: true, tin: true, vatPercent: true },
    });
    const dealerById = new Map(dealers.map((dealer) => [dealer.id, dealer]));

    const out = new Map<
      string,
      { tin: string | null; vatPercent: number | null }
    >();
    for (const seller of sellers) {
      const dealer = dealerById.get(
        CatalogProjectionService.catalogSellerIdFor(seller),
      );
      if (dealer) out.set(String(seller.tgId), dealerTaxData(dealer));
    }
    return out;
  }
}
