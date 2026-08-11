import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OrdersService } from '../../src/orders/orders.service';
import { OrderStatusService } from '../../src/orders/order-status.service';
import { createPrismaMock, fakeConfig, fakeNotifications, fakeRealtime, buildCart, buildCartItem, buildOrder, buildAppUser, fakeDiscounts, PrismaMock } from '../utils/harness';

describe('Orders smoke', () => {
  let prisma: PrismaMock;
  beforeEach(() => (prisma = createPrismaMock()));

  it('creates an order from the cart with correct totals and consumes the cart', async () => {
    const svc = new OrdersService(prisma, fakeConfig(), fakeNotifications(), fakeRealtime(), new OrderStatusService(prisma), fakeDiscounts());
    prisma.cart.findUnique.mockResolvedValue(
      buildCart({
        id: 'cart_1',
        userId: 'usr_1',
        items: [buildCartItem({ partId: 'part_belt', priceUzsSnapshot: 185000, quantity: 2 })],
      }),
    );
    prisma.appUser.findUnique.mockResolvedValue(buildAppUser({ phoneE164: '+998901234567' }));
    prisma.order.create.mockResolvedValue(
      buildOrder({
        id: 'ord_1',
        subtotalUzs: 370000,
        deliveryUzs: 25000,
        serviceFeeUzs: 5000,
        discountUzs: 0,
        totalUzs: 400000,
        items: [
          { partId: 'part_belt', serviceId: null, title: 'Timing belt', quantity: 2, priceUzs: 185000, lineTotalUzs: 370000, scheduledAt: null },
        ],
      }),
    );
    prisma.cartItem.deleteMany.mockResolvedValue({ count: 1 });
    prisma.cart.update.mockResolvedValue({});

    const res = await svc.createFromCart('usr_1', { cart_snapshot: { delivery_method: 'courier' } } as any);

    expect(prisma.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ subtotalUzs: 370000, deliveryUzs: 25000, serviceFeeUzs: 5000, totalUzs: 400000 }),
      }),
    );
    expect(prisma.cartItem.deleteMany).toHaveBeenCalledWith({ where: { cartId: 'cart_1' } });
    expect(res.order_id).toBe('ord_1');
    expect(res.status).toBe('pending_payment');
    expect(res.total_uzs).toBe(400000);
  });

  it('embeds a promo discount into the ITEM prices, exact to the tiyin', async () => {
    // MATOR10 = 10% off. The discount must end up inside the line prices, not
    // beside them: a Payme receipt has no discount field, so whatever the items
    // do not carry can never be fiscalized. Two lines that divide awkwardly
    // (3 × 33 333 and 1 × 100 001) so the flooring remainder is real.
    const svc = new OrdersService(prisma, fakeConfig(), fakeNotifications(), fakeRealtime(), new OrderStatusService(prisma), fakeDiscounts());
    prisma.cart.findUnique.mockResolvedValue(
      buildCart({
        id: 'cart_1',
        userId: 'usr_1',
        promoCode: 'MATOR10',
        items: [
          buildCartItem({ id: 'ci_1', partId: 'part_a', priceUzsSnapshot: 33333, quantity: 3 }),
          buildCartItem({ id: 'ci_2', partId: 'part_b', priceUzsSnapshot: 100001, quantity: 1 }),
        ],
      }),
    );
    prisma.appUser.findUnique.mockResolvedValue(buildAppUser({ phoneE164: '+998901234567' }));
    prisma.order.create.mockResolvedValue(buildOrder({ id: 'ord_1' }));
    prisma.cartItem.deleteMany.mockResolvedValue({ count: 2 });
    prisma.cart.update.mockResolvedValue({});

    await svc.createFromCart('usr_1', { cart_snapshot: { delivery_method: 'courier' } } as any);

    const { data } = prisma.order.create.mock.calls[0][0];
    const subtotal = 33333 * 3 + 100001; // 199 998
    const discount = Math.round(subtotal * 0.1); // 20 000
    expect(data.subtotalUzs).toBe(subtotal);
    expect(data.discountUzs).toBe(discount);

    // The written lines, in tiyin, must add up to the DISCOUNTED goods total —
    // this is the equality Payme re-checks, so a stray tiyin is a failed payment.
    const lines = data.items.create as { lineTotalUzs: number; priceUzs: number; quantity: number }[];
    const goodsTiyin = lines.reduce((s, l) => s + Math.round(l.lineTotalUzs * 100), 0);
    expect(goodsTiyin).toBe(Math.round((subtotal - discount) * 100));

    // …and the order's own total is the same goods plus the untouched fees.
    expect(Math.round(data.totalUzs * 100)).toBe(goodsTiyin + Math.round(30000 * 100));
  });

  it('rejects checkout on an empty cart', async () => {
    const svc = new OrdersService(prisma, fakeConfig(), fakeNotifications(), fakeRealtime(), new OrderStatusService(prisma), fakeDiscounts());
    prisma.cart.findUnique.mockResolvedValue(buildCart({ items: [] }));
    await expect(svc.createFromCart('usr_1', {} as any)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("does not return another user's order", async () => {
    const svc = new OrdersService(prisma, fakeConfig(), fakeNotifications(), fakeRealtime(), new OrderStatusService(prisma), fakeDiscounts());
    prisma.order.findUnique.mockResolvedValue(buildOrder({ id: 'ord_1', userId: 'someone_else' }));
    await expect(svc.getOrder('usr_1', 'ord_1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
