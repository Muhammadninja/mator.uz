import { CartLineDiscounts, CartWithItems, cartSubtotal, presentCart } from './cart.presenter';
import { DiscountResult } from '../sales/discount.service';

function item(over: Partial<CartWithItems['items'][number]> = {}): CartWithItems['items'][number] {
  return {
    id: 'ci_1',
    cartId: 'cart_1',
    partId: 'part_1',
    serviceId: null,
    providerId: null,
    vehicleId: null,
    title: 'Brake pad',
    imageUrl: null,
    quantity: 2,
    scheduledAt: null,
    priceUzsSnapshot: 100000 as never,
    createdAt: new Date(),
    ...over,
  };
}

function cart(items: CartWithItems['items']): CartWithItems {
  return {
    id: 'cart_1',
    userId: 'u_1',
    promoCode: null,
    promoDiscountUzs: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    items,
  } as CartWithItems;
}

const sale15: DiscountResult = {
  originalPrice: 100000,
  finalPrice: 85000,
  discountAmount: 15000,
  discountPercent: 15,
  appliedSale: { id: 's1', title: '15% off', discountType: 'PERCENT', discountValue: 15 },
};

describe('cart presenter — sale pricing', () => {
  it('charges the snapshot price when no sale applies', () => {
    const c = cart([item()]);
    expect(cartSubtotal(c)).toBe(200000);
    const out = presentCart(c);
    expect(out.items[0].price_uzs).toBe(100000);
    expect(out.items[0].sale).toBeNull();
    expect(out.subtotal_uzs).toBe(200000);
    expect(out.total_uzs).toBe(200000);
  });

  it('applies the per-line sale to the unit price, subtotal, and total', () => {
    const c = cart([item()]);
    const lineDiscounts: CartLineDiscounts = new Map([['ci_1', sale15]]);
    expect(cartSubtotal(c, lineDiscounts)).toBe(170000); // 85 000 × 2

    const out = presentCart(c, lineDiscounts);
    expect(out.items[0].price_uzs).toBe(85000);
    expect(out.items[0].original_price_uzs).toBe(100000);
    expect(out.items[0].sale).toMatchObject({ id: 's1', discount_percent: 15 });
    expect(out.subtotal_uzs).toBe(170000);
    expect(out.total_uzs).toBe(170000);
  });

  it('stacks a promo on top of the sale-adjusted subtotal', () => {
    const c = { ...cart([item()]), promoCode: 'SAVE10', promoDiscountUzs: 17000 as never };
    const lineDiscounts: CartLineDiscounts = new Map([['ci_1', sale15]]);
    const out = presentCart(c, lineDiscounts);
    expect(out.subtotal_uzs).toBe(170000); // sale-adjusted
    expect(out.total_uzs).toBe(153000); // 170 000 − 17 000 promo
  });
});
