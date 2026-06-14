import { CartService } from '../../src/cart/cart.service';
import { createPrismaMock, buildCart, buildCartItem, PrismaMock } from '../utils/harness';

describe('Cart smoke', () => {
  let prisma: PrismaMock;
  let svc: CartService;
  beforeEach(() => {
    prisma = createPrismaMock();
    svc = new CartService(prisma);
  });

  it('adds a new part line and reflects it in the snapshot', async () => {
    const empty = buildCart({ id: 'cart_1', userId: 'usr_1', items: [] });
    const withItem = buildCart({
      id: 'cart_1',
      userId: 'usr_1',
      items: [buildCartItem({ partId: 'part_belt', priceUzsSnapshot: 185000, quantity: 1 })],
    });
    prisma.cart.upsert.mockResolvedValueOnce(empty).mockResolvedValue(withItem);
    prisma.catalogPart.findUnique.mockResolvedValue({ id: 'part_belt', title: 'Timing belt', images: ['x'], priceUzs: 185000 });
    prisma.cartItem.create.mockResolvedValue({});

    const res = await svc.addItem('usr_1', { part_id: 'part_belt', quantity: 1 } as any);

    expect(prisma.cartItem.create).toHaveBeenCalled();
    expect(res.items).toHaveLength(1);
    expect(res.subtotal_uzs).toBe(185000);
  });

  it('merges a repeat part into the existing line (quantity increment)', async () => {
    const existing = buildCart({
      id: 'cart_1',
      userId: 'usr_1',
      items: [buildCartItem({ id: 'item_1', partId: 'part_belt', quantity: 1 })],
    });
    prisma.cart.upsert.mockResolvedValue(existing);
    prisma.catalogPart.findUnique.mockResolvedValue({ id: 'part_belt', title: 'Timing belt', images: [], priceUzs: 185000 });
    prisma.cartItem.update.mockResolvedValue({});

    await svc.addItem('usr_1', { part_id: 'part_belt', quantity: 2 } as any);

    expect(prisma.cartItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'item_1' }, data: { quantity: 3 } }),
    );
  });

  it('applies the MATOR10 promo as a 10% discount', async () => {
    const base = buildCart({
      id: 'cart_1',
      userId: 'usr_1',
      items: [buildCartItem({ priceUzsSnapshot: 185000, quantity: 1 })],
    });
    const promoed = buildCart({
      id: 'cart_1',
      userId: 'usr_1',
      promoCode: 'MATOR10',
      promoDiscountUzs: 18500,
      items: [buildCartItem({ priceUzsSnapshot: 185000, quantity: 1 })],
    });
    prisma.cart.upsert.mockResolvedValueOnce(base).mockResolvedValue(promoed);
    prisma.cart.update.mockResolvedValue({});

    const res = await svc.applyPromo('usr_1', 'MATOR10');

    expect(prisma.cart.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { promoCode: 'MATOR10', promoDiscountUzs: 18500 } }),
    );
    expect(res.promo).toEqual({ code: 'MATOR10', discountUzs: 18500, isValid: true });
    expect(res.total_uzs).toBe(166500);
  });

  it('previews an invalid promo without persisting it', async () => {
    const base = buildCart({ id: 'cart_1', userId: 'usr_1', items: [buildCartItem({ priceUzsSnapshot: 100000 })] });
    prisma.cart.upsert.mockResolvedValue(base);
    const res: any = await svc.applyPromo('usr_1', 'NOPE');
    expect(res.promo).toEqual({ code: 'NOPE', discountUzs: 0, isValid: false });
    expect(prisma.cart.update).not.toHaveBeenCalled();
  });
});
