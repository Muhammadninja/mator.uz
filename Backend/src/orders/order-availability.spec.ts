/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- the Prisma harness (test/utils/harness.ts) is untyped by design, like the other harness-based specs */
// The availability gate: out-of-stock, removed or suspended-dealer parts can
// no longer be added to a cart, ordered, invoiced or sent to Payme.

import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  PART_UNAVAILABLE,
  assertAllAvailable,
  findUnavailableParts,
} from './order-availability';
import { OrdersService } from './orders.service';
import { OrderStatusService } from './order-status.service';
import { PaymentsService } from './payments.service';
import { PaymeService } from './webhooks/payme.service';
import { CartService } from '../cart/cart.service';
import {
  buildCart,
  buildCartItem,
  buildOrder,
  createPrismaMock,
  fakeConfig,
  fakeDiscounts,
  fakeFiscal,
  fakeNotifications,
  fakeRealtime,
  PrismaMock,
} from '../../test/utils/harness';

const row = (id: string, inStock: boolean, status = 'PENDING') => ({
  id,
  inStock,
  seller: { status },
  categoryId: 'cat_1',
  sellerId: 'seller_1',
});

describe('findUnavailableParts', () => {
  let prisma: PrismaMock;
  beforeEach(() => (prisma = createPrismaMock()));

  it('names each unavailable line with its reason; services/offers are ignored', async () => {
    prisma.catalogPart.findMany.mockResolvedValue([
      row('in_stock', true),
      row('out', false),
      row('suspended', true, 'SUSPENDED'),
    ]);
    const res = await findUnavailableParts(prisma, [
      { partId: 'in_stock', title: 'A' },
      { partId: 'out', title: 'B' },
      { partId: 'suspended', title: 'C' },
      { partId: 'gone', title: 'D' },
      { partId: null, title: 'Sourced offer' },
    ]);
    expect(res).toEqual([
      { partId: 'out', title: 'B', reason: 'out_of_stock' },
      { partId: 'suspended', title: 'C', reason: 'dealer_suspended' },
      { partId: 'gone', title: 'D', reason: 'missing' },
    ]);
  });

  it('no part lines → no query, nothing unavailable', async () => {
    await expect(
      findUnavailableParts(prisma, [{ partId: null, title: 'Service' }]),
    ).resolves.toEqual([]);
    expect(prisma.catalogPart.findMany).not.toHaveBeenCalled();
  });

  it('assertAllAvailable throws 409 with the PART_UNAVAILABLE code', () => {
    expect(() =>
      assertAllAvailable([
        { partId: 'out', title: 'B', reason: 'out_of_stock' },
      ]),
    ).toThrow(ConflictException);
    try {
      assertAllAvailable([
        { partId: 'out', title: 'B', reason: 'out_of_stock' },
      ]);
    } catch (e) {
      expect((e as ConflictException).getResponse()).toMatchObject({
        code: PART_UNAVAILABLE,
      });
    }
    expect(() => assertAllAvailable([])).not.toThrow();
  });
});

describe('availability at each step', () => {
  let prisma: PrismaMock;
  beforeEach(() => (prisma = createPrismaMock()));

  it('cart: an out-of-stock part cannot be added (409); nothing is written', async () => {
    prisma.cart.findUnique.mockResolvedValue(
      buildCart({ id: 'cart_1', userId: 'usr_1' }),
    );
    prisma.catalogPart.findFirst.mockResolvedValue({
      id: 'part_x',
      title: 'X',
      images: [],
      priceUzs: 100,
      inStock: false,
    });
    const cart = new CartService(prisma, fakeDiscounts());
    await expect(
      cart.addItem('usr_1', { part_id: 'part_x' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.cartItem.create).not.toHaveBeenCalled();
  });

  it('cart: a suspended dealer part is not found (same visibility as the catalog)', async () => {
    prisma.cart.findUnique.mockResolvedValue(
      buildCart({ id: 'cart_1', userId: 'usr_1' }),
    );
    prisma.catalogPart.findFirst.mockResolvedValue(null);
    const cart = new CartService(prisma, fakeDiscounts());
    await expect(
      cart.addItem('usr_1', { part_id: 'part_x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.catalogPart.findFirst).toHaveBeenCalledWith({
      where: { id: 'part_x', seller: { status: { not: 'SUSPENDED' } } },
    });
  });

  it('order creation refuses a cart with an out-of-stock part; no order is created', async () => {
    prisma.cart.findUnique.mockResolvedValue(
      buildCart({
        id: 'cart_1',
        userId: 'usr_1',
        items: [buildCartItem({ partId: 'part_out', title: 'Brake pads' })],
      }),
    );
    prisma.catalogPart.findMany.mockResolvedValue([row('part_out', false)]);
    const svc = new OrdersService(
      prisma,
      fakeConfig(),
      fakeNotifications(),
      fakeRealtime(),
      new OrderStatusService(prisma),
      fakeDiscounts(),
    );
    await expect(svc.createFromCart('usr_1', {})).rejects.toThrow(
      /Brake pads \(out_of_stock\)/,
    );
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it('Payme invoice: refused (409) when a part went out of stock after ordering', async () => {
    prisma.order.findUnique.mockResolvedValue(
      buildOrder({ id: 'ord_1', userId: 'usr_1' }),
    );
    prisma.orderItem.findMany.mockResolvedValue([
      { partId: 'part_out', title: 'Brake pads' },
    ]);
    prisma.catalogPart.findMany.mockResolvedValue([row('part_out', false)]);
    const payments = new PaymentsService(
      prisma,
      fakeConfig({ PAYME_MERCHANT_ID: 'm', PAYME_MERCHANT_KEY: 'k' }),
      fakeFiscal(prisma),
    );
    await expect(
      payments.createPaymeInvoice('usr_1', { order_id: 'ord_1' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('Payme CheckPerformTransaction: -31008 before any money is held', async () => {
    const KEY = 'merchant-secret';
    const payme = new PaymeService(
      prisma,
      fakeConfig({
        PAYME_MERCHANT_KEY: KEY,
        PAYME_MERCHANT_ID: 'm',
        PAYME_ACCOUNT_FIELD: 'order_id',
      }),
      { markPaid: jest.fn(), markCancelled: jest.fn() } as never,
      fakeFiscal(prisma),
    );
    prisma.order.findUnique.mockResolvedValue(
      buildOrder({ id: 'ord_1', totalUzs: 215000 }),
    );
    prisma.orderItem.findMany.mockResolvedValue([
      { partId: 'part_out', title: 'Brake pads' },
    ]);
    prisma.catalogPart.findMany.mockResolvedValue([
      row('part_out', true, 'SUSPENDED'),
    ]);
    const res: any = await payme.handle(
      'Basic ' + Buffer.from(`Paycom:${KEY}`).toString('base64'),
      {
        id: 1,
        method: 'CheckPerformTransaction',
        params: { amount: 21_500_000, account: { order_id: 'ord_1' } },
      },
    );
    expect(res.error.code).toBe(-31008);
  });
});
