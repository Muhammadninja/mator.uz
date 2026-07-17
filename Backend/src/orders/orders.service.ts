import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeliveryMethod, OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { prefixedId, IdPrefix } from '../common/ulid.util';
import { resolvePromo } from '../cart/promo.util';
import { ORDER_INCLUDE, presentOrder } from './order.presenter';
import { CreateOrderDto } from './dto/create-order.dto';
import { ListOrdersQueryDto } from './dto/list-orders.query.dto';

const DEFAULT_ORDER_LIMIT = 20;

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async createFromCart(userId: string, dto: CreateOrderDto) {
    const cart = await this.prisma.cart.findUnique({
      where: { userId },
      include: { items: true },
    });
    if (!cart || cart.items.length === 0) {
      throw new BadRequestException('Cart is empty');
    }

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
}
