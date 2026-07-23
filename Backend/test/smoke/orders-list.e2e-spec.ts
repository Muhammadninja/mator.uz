import { OrdersService } from '../../src/orders/orders.service';
import { createPrismaMock, fakeConfig, fakeNotifications, fakeRealtime, buildOrder, PrismaMock } from '../utils/harness';

describe('Orders list smoke', () => {
  let prisma: PrismaMock;
  let svc: OrdersService;

  beforeEach(() => {
    prisma = createPrismaMock();
    svc = new OrdersService(prisma, fakeConfig(), fakeNotifications(), fakeRealtime());
  });

  it('lists orders scoped to the user and returns next_cursor=null when no more', async () => {
    prisma.order.findMany.mockResolvedValue([
      buildOrder({ id: 'ord_2', userId: 'usr_1' }),
      buildOrder({ id: 'ord_1', userId: 'usr_1' }),
    ]);

    const res: any = await svc.list('usr_1', { limit: 20 } as any);

    expect(res.items).toHaveLength(2);
    expect(res.next_cursor).toBeNull();
    const where = prisma.order.findMany.mock.calls[0][0].where;
    expect(where.userId).toBe('usr_1'); // ownership enforced
    expect(where.status).toBeUndefined();
  });

  it('applies the status filter (lowercase contract -> enum)', async () => {
    prisma.order.findMany.mockResolvedValue([buildOrder({ id: 'ord_1', userId: 'usr_1', status: 'PAID' })]);

    await svc.list('usr_1', { status: 'paid' } as any);

    expect(prisma.order.findMany.mock.calls[0][0].where.status).toBe('PAID');
  });

  it('paginates: returns next_cursor when there is an extra row beyond the limit', async () => {
    // limit=1 -> service fetches take=2; 2 rows means hasMore
    prisma.order.findMany.mockResolvedValue([
      buildOrder({ id: 'ord_2', userId: 'usr_1' }),
      buildOrder({ id: 'ord_1', userId: 'usr_1' }),
    ]);

    const res: any = await svc.list('usr_1', { limit: 1 } as any);

    expect(res.items).toHaveLength(1);
    expect(res.items[0].order_id).toBe('ord_2');
    expect(res.next_cursor).toBe('ord_2');
  });

  it('passes a keyset cursor through to Prisma', async () => {
    prisma.order.findMany.mockResolvedValue([]);
    await svc.list('usr_1', { cursor: 'ord_5' } as any);
    const args = prisma.order.findMany.mock.calls[0][0];
    expect(args.cursor).toEqual({ id: 'ord_5' });
    expect(args.skip).toBe(1);
  });
});
