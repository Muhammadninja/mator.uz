import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AdminAuditAction,
  AdminAuditEntity,
  AdminRole,
  DeliveryMethod,
  NotificationType,
  OrderStatus,
  PaymentType,
  Prisma,
} from '@prisma/client';
import { AdminAuditService } from '../admin/auth/admin-audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { prefixedId, IdPrefix } from '../common/ulid.util';
import { resolvePromo } from '../cart/promo.util';
import { priceCartLines } from '../cart/cart-pricing.util';
import { allocatePromoDiscount } from './promo-allocation.util';
import { DiscountService } from '../sales/discount.service';
import {
  DeliveryQuote,
  DeliveryQuoteService,
} from '../shipping/delivery-quote.service';
import { ORDER_INCLUDE, presentOrder } from './order.presenter';
import {
  ACTIVE_PROVIDER_STATE,
  OrderStatusService,
  TransitionActor,
} from './order-status.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { ListOrdersQueryDto } from './dto/list-orders.query.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { SYSTEM_ONLY_ORDER_STATUSES, canTransition } from './order-transitions';
import {
  DELIVERY_COST_UNAVAILABLE,
  DELIVERY_PRICE_CHANGED,
  DELIVERY_QUOTE_STALE,
  ORDER_TOTAL_CHANGED,
  PART_UNAVAILABLE,
  assertAllAvailable,
  findUnavailableParts,
} from './order-availability';
import { findLineSellers } from './order-settlement';
import {
  OrderCharges,
  PricedLine,
  computeOrderCharges,
  linesSubtotalUzs,
  toTiyin,
} from './service-fee.util';

const DEFAULT_ORDER_LIMIT = 20;

/**
 * What an order placed now would charge, as a 409 states it beside its code: the same figures,
 * named as the order and the cart name them. `delivery_quote_id` is the quote those figures
 * were computed with, or null when nothing is delivered by courier.
 */
function currentCharges(charges: OrderCharges, delivery: DeliveryQuote | null) {
  return {
    subtotal_uzs: charges.subtotalUzs,
    discount_uzs: charges.discountUzs,
    service_fee_uzs: charges.serviceFeeUzs,
    delivery_uzs: charges.deliveryUzs,
    total_uzs: charges.totalUzs,
    delivery_quote_id: delivery?.quoteId ?? null,
  };
}

/** Roles that may record an online payment by hand; see assertCanMarkPaid. */
const MANUAL_ONLINE_PAYMENT_ROLES: readonly AdminRole[] = [
  AdminRole.SUPER_ADMIN,
  AdminRole.MANAGER,
];

/** Re-exported for the controller: the acting user shape for an operator write. */
export type StatusActor = TransitionActor;

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeGateway,
    private readonly orderStatus: OrderStatusService,
    private readonly discounts: DiscountService,
    private readonly audit: AdminAuditService,
    private readonly deliveryQuotes: DeliveryQuoteService,
  ) {}

  async createFromCart(userId: string, dto: CreateOrderDto) {
    const cart = await this.prisma.cart.findUnique({
      where: { userId },
      include: { items: { include: { offer: { select: { sellerTgId: true } } } } },
    });
    if (!cart || cart.items.length === 0) {
      throw new BadRequestException('Cart is empty');
    }
    // A line that names no part, offer or service: its sourcing offer has been
    // deleted since it was accepted. Its order line could not say what was sold or
    // who sold it, so it stops here rather than at payment.
    const orphanLines = cart.items.filter(
      (i) => !i.partId && !i.offerId && !i.serviceId,
    );
    if (orphanLines.length > 0) {
      throw new ConflictException({
        code: PART_UNAVAILABLE,
        message: `No longer available: ${orphanLines
          .map((i) => `${i.title} (no_source)`)
          .join('; ')}`,
      });
    }
    // Never create an order for parts that can no longer be sold (out of stock,
    // removed, or a suspended dealer) — 409 PART_UNAVAILABLE naming them, so
    // the app can tell the buyer which cart lines to remove.
    assertAllAvailable(
      await findUnavailableParts(
        this.prisma,
        cart.items.map((i) => ({ partId: i.partId, title: i.title })),
      ),
    );

    // Ownership: a caller may only attach their OWN vehicle / delivery address to
    // an order. Without these checks the ids are persisted verbatim, letting a
    // user reference another user's vehicle or address (cross-tenant reference).
    await this.assertOwnedVehicle(userId, dto.vehicle_id);
    await this.assertOwnedAddress(userId, dto.cart_snapshot?.delivery_address_id);

    // Apply active sales per line, so the order is charged the SAME discounted
    // price the buyer saw in the catalog and cart. A line's charged unit price is
    // its sale price when a campaign applies, else its snapshot price.
    const lineDiscounts = await priceCartLines(this.prisma, this.discounts, cart.items);
    const unitPriceOf = (i: (typeof cart.items)[number]): number => {
      const d = lineDiscounts.get(i.id);
      return d?.appliedSale ? d.finalPrice : Number(i.priceUzsSnapshot);
    };

    // A sale can take a line to nothing (100%, or a fixed amount above the price).
    // There is no free-of-charge sale in the business: a campaign must not be able
    // to hand out goods by accident, so such a line stops the order.
    const freeLines = cart.items.filter(
      (i) => (i.partId || i.offerId) && !(unitPriceOf(i) > 0),
    );
    if (freeLines.length > 0) {
      throw new ConflictException({
        code: PART_UNAVAILABLE,
        message: `No longer available: ${freeLines
          .map((i) => `${i.title} (no_price)`)
          .join('; ')}`,
      });
    }

    const pricedLines: PricedLine[] = cart.items.map((i) => ({
      partId: i.partId,
      offerId: i.offerId,
      serviceId: i.serviceId,
      unitPriceUzs: unitPriceOf(i),
      quantity: i.quantity,
    }));
    const snap = dto.cart_snapshot ?? {};
    const deliveryMethod =
      String(snap.delivery_method ?? 'courier').toUpperCase() === 'PICKUP'
        ? DeliveryMethod.PICKUP
        : DeliveryMethod.COURIER;
    // Persist the chosen payment method (optional — older clients omit it).
    const PAYMENT_TYPE_MAP: Record<string, PaymentType> = {
      payme: PaymentType.PAYME,
      terminal: PaymentType.TERMINAL,
      cash: PaymentType.CASH,
    };
    const paymentType = dto.payment_type
      ? PAYMENT_TYPE_MAP[dto.payment_type]
      : undefined;
    // Courier delivery is charged what the backend computes now, never a figure from the
    // request. `confirmed_delivery_uzs` and `delivery_quote_id` only say what the buyer was
    // shown:
    //   • A client stating neither has shown no price (every build from before this, and one
    //     stating no method at all, since pickup is not assumed). Charging it would bill an
    //     amount the buyer never saw, so it is refused, and the customer keeps the cart and
    //     the choice of pickup.
    //   • A quote for other points or rates is refused, even at the same price: the buyer
    //     moved the saved destination, or a seller or the tariff changed, so they need a new
    //     quote for where the courier would now go.
    //   • A price that no longer matches is refused too: the cart or the roads changed, and
    //     the buyer agrees to the new one or not at all. Changing the number in the request
    //     therefore changes nothing but whether the order is placed.
    // Everything is settled before the transaction, so no network call happens inside it.
    const needsDeliveryCost =
      deliveryMethod === DeliveryMethod.COURIER &&
      cart.items.some((i) => i.partId || i.offerId);
    let delivery: DeliveryQuote | null = null;
    if (needsDeliveryCost) {
      if (dto.confirmed_delivery_uzs == null || !dto.delivery_quote_id) {
        throw new ConflictException({
          code: DELIVERY_COST_UNAVAILABLE,
          message:
            'The cost of courier delivery is not available yet. Choose pickup to place this order.',
        });
      }
      delivery = await this.deliveryQuotes.quote(
        userId,
        snap.delivery_address_id,
        cart.items,
      );
    }
    const discount = cart.promoCode
      ? resolvePromo(cart.promoCode, linesSubtotalUzs(pricedLines)).discountUzs
      : 0;
    // Every amount on the order comes from here, from the server's own cart. Nothing in the
    // request can state one: `confirmed_total_uzs` only says what the buyer was shown. A total
    // that no longer matches means the cart, a sale, the fee or the delivery tariff moved
    // since, so the buyer agrees to the new one or not at all. A client stating no total (an
    // older build) has shown none, and is charged what is computed here all the same.
    const charges = computeOrderCharges({
      lines: pricedLines,
      discountUzs: discount,
      deliveryUzs: delivery?.priceUzs ?? 0,
    });
    // Each refusal of an out-of-date confirmation says what an order placed now would charge,
    // so the buyer is shown the new figures and confirms them, or not. The total is compared
    // first: whatever moved it (rates that changed between the quote and now included), what
    // the buyer agreed to is no longer the total. The quote and the price are compared after,
    // so a different destination or set of pickups is refused even at the same total.
    const outOfDate = (code: string, message: string) =>
      new ConflictException({
        code,
        message,
        details: currentCharges(charges, delivery),
      });
    if (
      dto.confirmed_total_uzs != null &&
      toTiyin(dto.confirmed_total_uzs) !== toTiyin(charges.totalUzs)
    ) {
      throw outOfDate(
        ORDER_TOTAL_CHANGED,
        'The order total has changed. Check the new total and confirm the order again.',
      );
    }
    if (delivery && delivery.quoteId !== dto.delivery_quote_id) {
      throw outOfDate(
        DELIVERY_QUOTE_STALE,
        'The delivery details have changed. Check the new price and confirm the order again.',
      );
    }
    if (delivery && delivery.priceUzs !== dto.confirmed_delivery_uzs) {
      throw outOfDate(
        DELIVERY_PRICE_CHANGED,
        'The delivery price has changed. Check the new price and confirm the order again.',
      );
    }

    // Spread the promo discount INTO the line prices, in tiyin, so the charged
    // amount is carried entirely by the items. A Payme receipt has no negative
    // line and no discount field, so a discount left at order level has nowhere
    // to go on the receipt and the order becomes unpayable; embedded here, the
    // lines reconcile against the charge on their own. See promo-allocation.util.
    const allocation = allocatePromoDiscount(
      cart.items.map((i) => ({
        id: i.id,
        unitPriceTiyin: Math.round(unitPriceOf(i) * 100),
        quantity: i.quantity,
      })),
      Math.round(discount * 100),
    );

    const ttlMin = Number(this.config.get<string>('ORDER_TTL_MIN') ?? 30);
    const expiresAt = new Date(Date.now() + ttlMin * 60_000);
    const contactPhone =
      dto.contact_phone_e164 ??
      (await this.prisma.appUser.findUnique({ where: { id: userId } }))?.phoneE164 ??
      undefined;
    const lineSellers = await findLineSellers(this.prisma, cart.items);

    const order = await this.prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          id: prefixedId(IdPrefix.ORDER),
          userId,
          status: OrderStatus.PENDING_PAYMENT,
          subtotalUzs: charges.subtotalUzs,
          // Every charge is written once, here. Payment reads what this stored, so nothing
          // may change it later, least of all between Check and Perform.
          deliveryUzs: charges.deliveryUzs,
          ...(delivery
            ? {
                deliveryShipments:
                  delivery.shipments as unknown as Prisma.InputJsonValue,
                // A copy, so that editing or deleting the address cannot move this order.
                ...(delivery.destination
                  ? {
                      deliveryDestination:
                        delivery.destination as unknown as Prisma.InputJsonValue,
                    }
                  : {}),
              }
            : {}),
          serviceFeeUzs: charges.serviceFeeUzs,
          discountUzs: charges.discountUzs,
          totalUzs: charges.totalUzs,
          vehicleId: dto.vehicle_id,
          deliveryAddressId: snap.delivery_address_id ?? undefined,
          deliveryMethod,
          paymentType,
          contactPhoneE164: contactPhone,
          promoCode: cart.promoCode ?? undefined,
          expiresAt,
          items: {
            create: cart.items.map((i) => {
              // Net of the promo share. `lineTotalUzs` is the authority — for a
              // multi-unit line the net total need not divide evenly, so
              // priceUzs is its (floored) per-unit view and the two can differ
              // by tiyin. The receipt splits the line rather than trusting the
              // product back (see splitEvenLines).
              const share = allocation.get(i.id);
              const lineTotal = share
                ? share.effectiveLineTotalTiyin / 100
                : unitPriceOf(i) * i.quantity;
              const unit = share
                ? share.effectiveUnitPriceTiyin / 100
                : unitPriceOf(i);
              return {
                id: prefixedId(IdPrefix.ORDER_ITEM),
                partId: i.partId,
                serviceId: i.serviceId,
                providerId: i.providerId,
                // What an offer line sold and who sold it: without these it reads
                // as a line with no goods, and its receipt has no dealer to name.
                offerId: i.offerId,
                offerSellerTgId: i.offer?.sellerTgId ?? null,
                sellerId: lineSellers.get(i.id) ?? null,
                title: i.title,
                quantity: i.quantity,
                priceUzs: unit,
                lineTotalUzs: lineTotal,
                scheduledAt: i.scheduledAt,
              };
            }),
          },
        },
        include: ORDER_INCLUDE,
      });

      // First history entry: the order's creation. Written in the same tx so an
      // order can never exist without its opening audit row.
      await this.orderStatus.recordCreation(tx, created.id, OrderStatus.PENDING_PAYMENT);

      // The cart is consumed by the order.
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
      await tx.cart.update({
        where: { id: cart.id },
        data: { promoCode: null, promoDiscountUzs: null },
      });
      return created;
    });

    return presentOrder(order);
  }

  /**
   * Order history for the authenticated user. Keyset pagination by
   * (createdAt desc, id desc); always scoped to userId so ownership is enforced
   * by construction. Optional status filter (contract lowercase → enum).
   */
  async list(userId: string, query: ListOrdersQueryDto) {
    const limit = query.limit ?? DEFAULT_ORDER_LIMIT;
    const where: Prisma.OrderWhereInput = { userId };
    if (query.status) {
      where.status = query.status.toUpperCase() as OrderStatus;
    }

    const rows = await this.prisma.order.findMany({
      where,
      include: ORDER_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: items.map(presentOrder),
      next_cursor: hasMore ? items[items.length - 1].id : null,
    };
  }

  async getOrder(userId: string, orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: ORDER_INCLUDE,
    });
    if (!order || order.userId !== userId) throw new NotFoundException('Order not found');
    return presentOrder(order);
  }

  /**
   * Operator status write (PATCH /v1/orders/:id/status). Enforces the
   * server-authoritative state machine (order-transitions.ts), persists
   * the new status, then broadcasts to the owning customer via the same channels
   * the payment webhook already uses (realtime socket + inbox/push notification)
   * so the app reflects the change without waiting for the next poll.
   */
  async updateStatus(
    orderId: string,
    dto: UpdateOrderStatusDto,
    actor?: StatusActor,
    provenance: { ip?: string; userAgent?: string } = {},
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: ORDER_INCLUDE,
    });
    if (!order) throw new NotFoundException('Order not found');

    const from = order.status;
    const to = dto.status.toUpperCase() as OrderStatus;
    if (from !== to && !canTransition(from, to)) {
      throw new BadRequestException(
        `Illegal transition ${from.toLowerCase()} → ${to.toLowerCase()}`,
      );
    }

    // Idempotent: re-sending the current status is a no-op (no re-broadcast).
    if (from === to) return presentOrder(order);

    if (SYSTEM_ONLY_ORDER_STATUSES.includes(to)) {
      throw new BadRequestException(
        `Status ${to.toLowerCase()} is set by the system, not by an operator`,
      );
    }
    const note = (dto.note ?? dto.reason)?.trim() || null;
    if (to === OrderStatus.CANCELLED && !note) {
      throw new BadRequestException({
        code: 'CANCEL_REASON_REQUIRED',
        message: 'Cancelling an order needs a reason.',
      });
    }
    const paymentsOnFile =
      to === OrderStatus.PAID
        ? await this.assertCanMarkPaid(order, note, actor)
        : null;
    const paymentReference = dto.paymentReference?.trim() || null;

    // Persist the transition + its audit row atomically through the single
    // status chokepoint, then re-read for the broadcast/response. CONDITIONAL on
    // the status we validated against: if a payment webhook (or another
    // operator) moved the order meanwhile, this write must not silently
    // overwrite it — e.g. cancel an order that was paid a moment ago.
    //
    // A payment confirmation or a cancellation also leaves an audit entry in the
    // same transaction: the history records the lifecycle, the audit entry what
    // an operator is accountable for about the money.
    const moved = await this.prisma.$transaction(async (tx) => {
      const changed = await this.orderStatus.transitionIf(orderId, [from], to, {
        tx,
        actor,
        note: paymentReference
          ? `${note ?? ''} [${paymentReference}]`.trim().slice(0, 500)
          : note,
      });
      if (
        changed &&
        actor &&
        (to === OrderStatus.PAID || to === OrderStatus.CANCELLED)
      ) {
        await this.audit.record(
          {
            action:
              to === OrderStatus.PAID
                ? AdminAuditAction.ORDER_PAYMENT_CONFIRMED
                : AdminAuditAction.ORDER_CANCELLED,
            actor: {
              id: actor.id,
              email: actor.email ?? '',
              name: actor.displayName ?? '',
            },
            target: {
              entity: AdminAuditEntity.ORDER,
              id: orderId,
              name: orderId,
            },
            previousValues: {
              status: from,
              paymentType: order.paymentType,
              ...(paymentsOnFile ? { payments: paymentsOnFile } : {}),
            },
            newValues: {
              status: to,
              ...(paymentReference ? { paymentReference } : {}),
            },
            reason: note,
            ip: provenance.ip,
            userAgent: provenance.userAgent,
          },
          tx,
        );
      }
      return changed;
    });
    if (!moved) {
      throw new ConflictException(
        'Order status changed meanwhile — reload and try again',
      );
    }
    const updated = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: ORDER_INCLUDE,
    });

    // Notify the owning customer the same way the payment webhook does:
    // live socket event + persisted inbox row / push (gated by prefs). Best
    // effort, for the webhook's reason: the transition is committed, so a failing
    // socket or inbox write must not tell the operator it did not happen, which
    // is what would make them retry into a 409.
    try {
      this.realtime.emit(order.userId, {
        type: 'order_status_changed',
        data: {
          order_id: order.id,
          status: to.toLowerCase(),
          previous_status: from.toLowerCase(),
        },
      });
      await this.notifications.emit(order.userId, {
        type: NotificationType.ORDER_STATUS_CHANGED,
        title: 'Buyurtma holati yangilandi',
        body: `Buyurtmangiz holati "${to.toLowerCase()}" ga o'zgardi.`,
        data: { order_id: order.id, status: to.toLowerCase() },
        deeplinkPath: '/(tabs)/(cart)/order-confirmation',
      });
    } catch (err) {
      this.logger.error(
        `Status notification failed for order ${order.id}: ${(err as Error).message}`,
      );
    }
    this.logger.log(`Order ${order.id} status ${from.toLowerCase()} → ${to.toLowerCase()} (operator)`);

    return presentOrder(updated);
  }

  /**
   * Marking an order paid is how an operator records money that reached them
   * outside a provider. For cash or a terminal that is the normal flow. For an order
   * paid online it is an exception, because PAID ends the order's payability and the
   * provider then refuses the customer's own payment:
   *   • a provider transaction in progress always wins: the customer is paying right
   *     now, so the provider decides, and this write would fail their payment;
   *   • otherwise it is for reconciling a payment confirmed some other way (a failed
   *     callback), so only a manager or super admin may do it, and it must say how.
   *
   * @returns what the payment rows said at that moment, for the audit entry.
   */
  private async assertCanMarkPaid(
    order: { id: string; paymentType: PaymentType | null },
    note: string | null,
    actor?: StatusActor,
  ) {
    const payments = await this.prisma.payment.findMany({
      where: { orderId: order.id },
      select: {
        id: true,
        provider: true,
        status: true,
        providerState: true,
        providerTransactionId: true,
      },
    });
    if (payments.some((p) => p.providerState === ACTIVE_PROVIDER_STATE)) {
      throw new ConflictException({
        code: 'PAYMENT_IN_PROGRESS',
        message:
          'The customer has a payment in progress with the provider. It will mark the order paid when it completes.',
      });
    }

    // An order from a client that recorded no method counts as online once it has
    // a payment row. One that says CASH stays offline even with a stale row left by
    // an abandoned checkout.
    const online =
      order.paymentType === PaymentType.PAYME ||
      (order.paymentType === null && payments.length > 0);
    if (!online) return payments;

    if (!actor?.adminRole || !MANUAL_ONLINE_PAYMENT_ROLES.includes(actor.adminRole)) {
      throw new ForbiddenException({
        code: 'PAYMENT_CONFIRM_FORBIDDEN',
        message:
          'Only a manager or super admin can mark an online order paid by hand.',
      });
    }
    if (!note) {
      throw new BadRequestException({
        code: 'PAYMENT_NOTE_REQUIRED',
        message:
          'This order is paid online. Marking it paid by hand needs a note saying how the payment was confirmed.',
      });
    }
    return payments;
  }

  // ── ownership helpers ────────────────────────────────────────────────────────
  /** Ensure the referenced vehicle (if any) belongs to the caller. */
  private async assertOwnedVehicle(userId: string, vehicleId?: string): Promise<void> {
    if (!vehicleId) return;
    const vehicle = await this.prisma.vehicle.findUnique({ where: { id: vehicleId } });
    if (!vehicle || vehicle.userId !== userId || vehicle.deletedAt) {
      throw new NotFoundException('Vehicle not found');
    }
  }

  /** Ensure the referenced delivery address (if any) belongs to the caller. */
  private async assertOwnedAddress(userId: string, addressId?: string): Promise<void> {
    if (!addressId) return;
    const address = await this.prisma.address.findUnique({ where: { id: addressId } });
    if (!address || address.userId !== userId) {
      throw new NotFoundException('Address not found');
    }
  }
}
