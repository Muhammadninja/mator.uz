import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { prefixedId, IdPrefix } from '../common/ulid.util';
import { AddCartItemDto } from './dto/add-cart-item.dto';
import { resolvePromo } from './promo.util';
import { CART_INCLUDE, CartWithItems, cartSubtotal, presentCart } from './cart.presenter';

@Injectable()
export class CartService {
  constructor(private readonly prisma: PrismaService) {}

  private getOrCreate(userId: string): Promise<CartWithItems> {
    return this.prisma.cart.upsert({
      where: { userId },
      create: { id: prefixedId(IdPrefix.CART), userId },
      update: {},
      include: CART_INCLUDE,
    });
  }

  /** Always re-reads the cart and re-derives the promo discount from the live subtotal. */
  async snapshot(userId: string) {
    const cart = await this.getOrCreate(userId);
    return presentCart(await this.refreshPromo(cart));
  }

  async addItem(userId: string, dto: AddCartItemDto) {
    const cart = await this.getOrCreate(userId);

    if (dto.service_id) {
      const svc = await this.prisma.providerServiceOffering.findUnique({
        where: { id: dto.service_id },
      });
      if (!svc) throw new NotFoundException('Service not found');
      await this.prisma.cartItem.create({
        data: {
          id: prefixedId(IdPrefix.CART_ITEM),
          cartId: cart.id,
          serviceId: svc.id,
          providerId: dto.provider_id,
          vehicleId: dto.vehicle_id,
          scheduledAt: dto.scheduled_at ? new Date(dto.scheduled_at) : undefined,
          title: svc.name,
          priceUzsSnapshot: svc.priceUzs,
          quantity: 1,
        },
      });
    } else {
      const partId = dto.part_id ?? dto.id;
      if (!partId) throw new BadRequestException('part_id or service_id is required');
      const part = await this.prisma.catalogPart.findUnique({ where: { id: partId } });
      if (!part) throw new NotFoundException('Part not found');
      const qty = dto.quantity ?? 1;

      // Merge: an existing part line increments its quantity.
      const existing = cart.items.find((i) => i.partId === partId && !i.serviceId);
      if (existing) {
        await this.prisma.cartItem.update({
          where: { id: existing.id },
          data: { quantity: existing.quantity + qty },
        });
      } else {
        await this.prisma.cartItem.create({
          data: {
            id: prefixedId(IdPrefix.CART_ITEM),
            cartId: cart.id,
            partId,
            vehicleId: dto.vehicle_id,
            title: part.title,
            imageUrl: part.images[0] ?? null,
            priceUzsSnapshot: part.priceUzs,
            quantity: qty,
          },
        });
      }
    }

    return this.snapshot(userId);
  }

  async updateItem(userId: string, itemId: string, quantity: number) {
    await this.assertItemOwned(userId, itemId);
    if (quantity <= 0) {
      await this.prisma.cartItem.delete({ where: { id: itemId } });
    } else {
      await this.prisma.cartItem.update({ where: { id: itemId }, data: { quantity } });
    }
    return this.snapshot(userId);
  }

  async removeItem(userId: string, itemId: string) {
    await this.assertItemOwned(userId, itemId);
    await this.prisma.cartItem.delete({ where: { id: itemId } });
    return this.snapshot(userId);
  }

  async clear(userId: string) {
    const cart = await this.getOrCreate(userId);
    await this.prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
    return this.snapshot(userId);
  }

  async applyPromo(userId: string, code: string) {
    const cart = await this.getOrCreate(userId);
    const result = resolvePromo(code, cartSubtotal(cart));
    if (!result.isValid) {
      // Preview only — do not persist an invalid code.
      const snap = presentCart(cart);
      return { ...snap, promo: { code, discountUzs: 0, isValid: false } };
    }
    await this.prisma.cart.update({
      where: { id: cart.id },
      data: { promoCode: code.trim().toUpperCase(), promoDiscountUzs: result.discountUzs },
    });
    return this.snapshot(userId);
  }

  async removePromo(userId: string) {
    const cart = await this.getOrCreate(userId);
    await this.prisma.cart.update({
      where: { id: cart.id },
      data: { promoCode: null, promoDiscountUzs: null },
    });
    return this.snapshot(userId);
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  private async assertItemOwned(userId: string, itemId: string) {
    const item = await this.prisma.cartItem.findUnique({
      where: { id: itemId },
      include: { cart: true },
    });
    if (!item || item.cart.userId !== userId) {
      throw new NotFoundException('Cart item not found');
    }
    return item;
  }

  private async refreshPromo(cart: CartWithItems): Promise<CartWithItems> {
    if (!cart.promoCode) return cart;
    const result = resolvePromo(cart.promoCode, cartSubtotal(cart));
    if (!result.isValid) {
      return this.prisma.cart.update({
        where: { id: cart.id },
        data: { promoCode: null, promoDiscountUzs: null },
        include: CART_INCLUDE,
      });
    }
    if (Number(cart.promoDiscountUzs ?? 0) !== result.discountUzs) {
      return this.prisma.cart.update({
        where: { id: cart.id },
        data: { promoDiscountUzs: result.discountUzs },
        include: CART_INCLUDE,
      });
    }
    return cart;
  }
}
