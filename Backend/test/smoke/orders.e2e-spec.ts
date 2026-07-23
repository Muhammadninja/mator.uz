import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OrdersService } from '../../src/orders/orders.service';
import { createPrismaMock, fakeConfig, fakeNotifications, fakeRealtime, buildCart, buildCartItem, buildOrder, buildAppUser, PrismaMock } from '../utils/harness';

describe('Orders smoke', () => {
  let prisma: PrismaMock;
  beforeEach(() => (prisma = createPrismaMock()));

  it('creates an order from the cart with correct totals and consumes the cart', async () => {
    const svc = new OrdersService(prisma, fakeConfig(), fakeNotifications(), fakeRealtime());
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

  it('rejects checkout on an empty cart', async () => {
    const svc = new OrdersService(prisma, fakeConfig(), fakeNotifications(), fakeRealtime());
    prisma.cart.findUnique.mockResolvedValue(buildCart({ items: [] }));
    await expect(svc.createFromCart('usr_1', {} as any)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("does not return another user's order", async () => {
    const svc = new OrdersService(prisma, fakeConfig(), fakeNotifications(), fakeRealtime());
    prisma.order.findUnique.mockResolvedValue(buildOrder({ id: 'ord_1', userId: 'someone_else' }));
    await expect(svc.getOrder('usr_1', 'ord_1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
