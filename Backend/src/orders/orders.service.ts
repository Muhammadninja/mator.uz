import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeliveryMethod, NotificationType, OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { prefixedId, IdPrefix } from '../common/ulid.util';
import { resolvePromo } from '../cart/promo.util';
import { ORDER_INCLUDE, presentOrder } from './order.presenter';
import { OrderStatusService, TransitionActor } from './order-status.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { ListOrdersQueryDto } from './dto/list-orders.query.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';

const DEFAULT_ORDER_LIMIT = 20;

/** Re-exported for the controller: the acting user shape for an operator write. */
export type StatusActor = TransitionActor;

/**
 * Server-authoritative order state machine for operator status writes.
 * Mapped onto the existing Prisma `OrderStatus` enum (not the contract's
 * `confirmed/packed/out_for_delivery` vocabulary, which has no schema column):
 * `PENDING_PAYMENT → PAID → PROCESSING → SHIPPED → DELIVERED`, with
 * `CANCELLED`/`REFUNDED`/`EXPIRED` terminal. Illegal jumps are rejected with 400.
 */
const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.PENDING_PAYMENT]: [OrderStatus.PAID, OrderStatus.CANCELLED, OrderStatus.EXPIRED],
  [OrderStatus.PAID]: [OrderStatus.PROCESSING, OrderStatus.CANCELLED, OrderStatus.REFUNDED],
  [OrderStatus.PROCESSING]: [OrderStatus.SHIPPED, OrderStatus.CANCELLED, OrderStatus.REFUNDED],
  [OrderStatus.SHIPPED]: [OrderStatus.DELIVERED, OrderStatus.CANCELLED],
  [OrderStatus.DELIVERED]: [],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.REFUNDED]: [],
  [OrderStatus.EXPIRED]: [],
};

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeGateway,
    private readonly orderStatus: OrderStatusService,
  ) {}

  async createFromCart(userId: string, dto: CreateOrderDto) {
    const cart = await this.prisma.cart.findUnique({
      where: { userId },
      include: { items: true },
    });
    if (!cart || cart.items.length === 0) {
      throw new BadRequestException('Cart is empty');
    }

    // Ownership: a caller may only attach their OWN vehicle / delivery address to
    // an order. Without these checks the ids are persisted verbatim, letting a
    // user reference another user's vehicle or address (cross-tenant reference).
    await this.assertOwnedVehicle(userId, dto.vehicle_id);
    await this.assertOwnedAddress(userId, dto.cart_snapshot?.delivery_address_id);

    const subtotal = cart.items.reduce((s, i) => s + Number(i.priceUzsSnapshot) * i.quantity, 0);
    const snap = dto.cart_snapshot ?? {};
    const deliveryMethod =
      String(snap.delivery_method ?? 'courier').toUpperCase() === 'PICKUP'
        ? DeliveryMethod.PICKUP
        : DeliveryMethod.COURIER;
    const deliveryUzs =
      deliveryMethod === DeliveryMethod.PICKUP
        ? 0
        : Number(this.config.get<string>('DELIVERY_COURIER_UZS') ?? 25000);
    const serviceFeeUzs = Number(this.config.get<string>('SERVICE_FEE_UZS') ?? 5000);
    const discount = cart.promoCode ? resolvePromo(cart.promoCode, subtotal).discountUzs : 0;
    const total = Math.max(0, subtotal + deliveryUzs + serviceFeeUzs - discount);

    const ttlMin = Number(this.config.get<string>('ORDER_TTL_MIN') ?? 30);
    const expiresAt = new Date(Date.now() + ttlMin * 60_000);
    const contactPhone =
      dto.contact_phone_e164 ??
      (await this.prisma.appUser.findUnique({ where: { id: userId } }))?.phoneE164 ??
      undefined;

    const order = await this.prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          id: prefixedId(IdPrefix.ORDER),
          userId,
          status: OrderStatus.PENDING_PAYMENT,
          subtotalUzs: subtotal,
          deliveryUzs,
          serviceFeeUzs,
          discountUzs: discount,
          totalUzs: total,
          vehicleId: dto.vehicle_id,
          deliveryAddressId: snap.delivery_address_id ?? undefined,
          deliveryMethod,
          contactPhoneE164: contactPhone,
          promoCode: cart.promoCode ?? undefined,
          expiresAt,
          items: {
            create: cart.items.map((i) => ({
              id: prefixedId(IdPrefix.ORDER_ITEM),
              partId: i.partId,
              serviceId: i.serviceId,
              providerId: i.providerId,
              title: i.title,
              quantity: i.quantity,
              priceUzs: i.priceUzsSnapshot,
              lineTotalUzs: Number(i.priceUzsSnapshot) * i.quantity,
              scheduledAt: i.scheduledAt,
            })),
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
   * server-authoritative state machine ({@link ALLOWED_TRANSITIONS}), persists
   * the new status, then broadcasts to the owning customer via the same channels
   * the payment webhook already uses (realtime socket + inbox/push notification)
   * so the app reflects the change without waiting for the next poll.
   */
  async updateStatus(orderId: string, dto: UpdateOrderStatusDto, actor?: StatusActor) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: ORDER_INCLUDE,
    });
    if (!order) throw new NotFoundException('Order not found');

    const from = order.status;
    const to = dto.status.toUpperCase() as OrderStatus;
    if (from !== to && !ALLOWED_TRANSITIONS[from]?.includes(to)) {
      throw new BadRequestException(
        `Illegal transition ${from.toLowerCase()} → ${to.toLowerCase()}`,
      );
    }

    // Idempotent: re-sending the current status is a no-op (no re-broadcast).
    if (from === to) return presentOrder(order);

    // Persist the transition + its audit row atomically through the single
    // status chokepoint, then re-read for the broadcast/response.
    await this.orderStatus.transition(orderId, to, {
      actor,
      note: dto.note ?? dto.reason ?? null,
    });
    const updated = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: ORDER_INCLUDE,
    });

    // Notify the owning customer the same way the payment webhook does:
    // live socket event + persisted inbox row / push (gated by prefs).
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
    this.logger.log(`Order ${order.id} status ${from.toLowerCase()} → ${to.toLowerCase()} (operator)`);

    return presentOrder(updated);
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
