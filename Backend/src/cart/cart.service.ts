import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { prefixedId, IdPrefix } from '../common/ulid.util';
import { AddCartItemDto, MAX_CART_ITEM_QUANTITY } from './dto/add-cart-item.dto';
import { resolvePromo } from './promo.util';
import {
  CART_INCLUDE,
  CartLineDiscounts,
  CartWithItems,
  cartSubtotal,
  presentCart,
} from './cart.presenter';
import { priceCartLines } from './cart-pricing.util';
import { DiscountService } from '../sales/discount.service';

@Injectable()
export class CartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly discounts: DiscountService,
  ) {}

  /** Active-sale result for each part line, keyed by cart-item id. */
  private lineDiscounts(cart: CartWithItems): Promise<CartLineDiscounts> {
    return priceCartLines(this.prisma, this.discounts, cart.items);
  }

  private getOrCreate(userId: string): Promise<CartWithItems> {
    return this.prisma.cart.upsert({
      where: { userId },
      create: { id: prefixedId(IdPrefix.CART), userId },
      update: {},
      include: CART_INCLUDE,
    });
  }

  /** Always re-reads the cart, applies active sales per line, and re-derives the
   *  promo discount from the sale-adjusted subtotal. */
  async snapshot(userId: string) {
    const cart = await this.getOrCreate(userId);
    const lineDiscounts = await this.lineDiscounts(cart);
    const priced = await this.refreshPromo(cart, lineDiscounts);
    // Item set (and their ids) is unchanged by refreshPromo, so the line
    // discounts computed above still key correctly onto the refreshed cart.
    return presentCart(priced, lineDiscounts);
  }

  async addItem(userId: string, dto: AddCartItemDto) {
    const cart = await this.getOrCreate(userId);

    // Ownership: a caller may only attach their OWN vehicle to a cart line.
    // (provider_id references the public provider directory, not a user-owned
    // resource, so it is not ownership-scoped.)
    await this.assertOwnedVehicle(userId, dto.vehicle_id);

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

      // Merge: an existing part line increments its quantity. The merged total is
      // capped server-side — DTO @Max(999) bounds a single request, but repeated
      // adds could otherwise stack past the ceiling.
      const existing = cart.items.find((i) => i.partId === partId && !i.serviceId);
      if (existing) {
        await this.prisma.cartItem.update({
          where: { id: existing.id },
          data: { quantity: Math.min(existing.quantity + qty, MAX_CART_ITEM_QUANTITY) },
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

  /**
   * Add an accepted sourcing offer to the cart as a self-contained line (no
   * catalog part — the title/price/image are carried on the row). Idempotent:
   * re-accepting an offer already in the cart just returns the current snapshot
   * rather than stacking duplicate lines. Called by SourcingOfferService inside
   * the accept transaction.
   */
  async addSourcedOffer(
    userId: string,
    input: { offerId: string; title: string; priceUzs: number | string; imageUrl?: string | null },
  ) {
    const cart = await this.getOrCreate(userId);
    const already = cart.items.find((i) => i.offerId === input.offerId);
    if (!already) {
      await this.prisma.cartItem.create({
        data: {
          id: prefixedId(IdPrefix.CART_ITEM),
          cartId: cart.id,
          offerId: input.offerId,
          title: input.title,
          imageUrl: input.imageUrl ?? null,
          priceUzsSnapshot: input.priceUzs,
          quantity: 1,
        },
      });
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
    // Promo stacks on top of sales: validate/compute it against the sale-adjusted
    // subtotal, never the raw one.
    const lineDiscounts = await this.lineDiscounts(cart);
    const result = resolvePromo(code, cartSubtotal(cart, lineDiscounts));
    if (!result.isValid) {
      // Preview only — do not persist an invalid code.
      const snap = presentCart(cart, lineDiscounts);
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
  /** Ensure the referenced vehicle (if any) belongs to the caller. */
  private async assertOwnedVehicle(userId: string, vehicleId?: string): Promise<void> {
    if (!vehicleId) return;
    const vehicle = await this.prisma.vehicle.findUnique({ where: { id: vehicleId } });
    if (!vehicle || vehicle.userId !== userId || vehicle.deletedAt) {
      throw new NotFoundException('Vehicle not found');
    }
  }

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

  private async refreshPromo(
    cart: CartWithItems,
    lineDiscounts?: CartLineDiscounts,
  ): Promise<CartWithItems> {
    if (!cart.promoCode) return cart;
    const result = resolvePromo(cart.promoCode, cartSubtotal(cart, lineDiscounts));
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
