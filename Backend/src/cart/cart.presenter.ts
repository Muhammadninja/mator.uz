import { Prisma } from '@prisma/client';
import { formatUzs } from '../catalog/parts/part.presenter';
import type { DiscountResult } from '../sales/discount.service';

export const CART_INCLUDE = { items: { orderBy: { createdAt: 'asc' } } } satisfies Prisma.CartInclude;
export type CartWithItems = Prisma.CartGetPayload<{ include: typeof CART_INCLUDE }>;

/** Per-line sale results, keyed by cart-item id. */
export type CartLineDiscounts = Map<string, DiscountResult>;

/** The unit price a line is actually charged — the sale price when one applies,
 *  else the snapshot price. */
function unitPrice(
  item: CartWithItems['items'][number],
  lineDiscounts?: CartLineDiscounts,
): number {
  const d = lineDiscounts?.get(item.id);
  return d?.appliedSale ? d.finalPrice : Number(item.priceUzsSnapshot);
}

export function cartSubtotal(
  cart: CartWithItems,
  lineDiscounts?: CartLineDiscounts,
): number {
  return cart.items.reduce((sum, i) => sum + unitPrice(i, lineDiscounts) * i.quantity, 0);
}

export function presentCart(cart: CartWithItems, lineDiscounts?: CartLineDiscounts) {
  const subtotal = cartSubtotal(cart, lineDiscounts);
  const discount = cart.promoCode ? Number(cart.promoDiscountUzs ?? 0) : 0;
  return {
    items: cart.items.map((i) => {
      const d = lineDiscounts?.get(i.id);
      const applied = d?.appliedSale ? d : null;
      const unit = applied ? applied.finalPrice : Number(i.priceUzsSnapshot);
      return {
        id: i.id,
        part_id: i.partId,
        service_id: i.serviceId,
        title: i.title,
        price: formatUzs(unit),
        price_uzs: unit,
        // Pre-discount price + the winning sale, present only when one applies.
        original_price_uzs: applied ? applied.originalPrice : null,
        original_price_label: applied ? formatUzs(applied.originalPrice) : null,
        sale: applied
          ? {
              id: applied.appliedSale!.id,
              title: applied.appliedSale!.title,
              discount_type: applied.appliedSale!.discountType,
              discount_value: applied.appliedSale!.discountValue,
              discount_percent: applied.discountPercent,
              discount_amount_uzs: applied.discountAmount,
            }
          : null,
        quantity: i.quantity,
        imageUrl: i.imageUrl,
        scheduled_at: i.scheduledAt ? i.scheduledAt.toISOString() : null,
      };
    }),
    promo: cart.promoCode
      ? { code: cart.promoCode, discountUzs: discount, isValid: true }
      : null,
    subtotal_uzs: subtotal,
    total_uzs: Math.max(0, subtotal - discount),
  };
}
