import { Prisma } from '@prisma/client';
import { formatUzs } from '../catalog/parts/part.presenter';

export const CART_INCLUDE = { items: { orderBy: { createdAt: 'asc' } } } satisfies Prisma.CartInclude;
export type CartWithItems = Prisma.CartGetPayload<{ include: typeof CART_INCLUDE }>;

export function cartSubtotal(cart: CartWithItems): number {
  return cart.items.reduce((sum, i) => sum + Number(i.priceUzsSnapshot) * i.quantity, 0);
}

export function presentCart(cart: CartWithItems) {
  const subtotal = cartSubtotal(cart);
  const discount = cart.promoCode ? Number(cart.promoDiscountUzs ?? 0) : 0;
  return {
    items: cart.items.map((i) => ({
      id: i.id,
      part_id: i.partId,
      service_id: i.serviceId,
      title: i.title,
      price: formatUzs(i.priceUzsSnapshot),
      price_uzs: Number(i.priceUzsSnapshot),
      quantity: i.quantity,
      imageUrl: i.imageUrl,
      scheduled_at: i.scheduledAt ? i.scheduledAt.toISOString() : null,
    })),
    promo: cart.promoCode
      ? { code: cart.promoCode, discountUzs: discount, isValid: true }
      : null,
    subtotal_uzs: subtotal,
    total_uzs: Math.max(0, subtotal - discount),
  };
}
