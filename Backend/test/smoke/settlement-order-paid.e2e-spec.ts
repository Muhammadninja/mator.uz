import { SettlementService } from '../../src/orders/webhooks/settlement.service';
import { createPrismaMock, PrismaMock } from '../utils/harness';

describe('Settlement order_paid WS emit smoke', () => {
  let prisma: PrismaMock;
  let notifications: { emit: jest.Mock };
  let realtime: { emit: jest.Mock };
  let svc: SettlementService;

  beforeEach(() => {
    prisma = createPrismaMock();
    notifications = { emit: jest.fn().mockResolvedValue(undefined) };
    realtime = { emit: jest.fn() };
    svc = new SettlementService(prisma, notifications as any, realtime as any);
  });

  it('markPaid flips order + payment, emits order_paid over WS, and notifies', async () => {
    prisma.payment.findUnique.mockResolvedValue({
      id: 'pay_1',
      orderId: 'ord_1',
      status: 'PENDING',
      amountUzs: 215000,
      order: { userId: 'usr_1' },
    });

    await svc.markPaid('pay_1', 1700000000000);

    expect(realtime.emit).toHaveBeenCalledWith('usr_1', {
      type: 'order_paid',
      data: { order_id: 'ord_1', payment_id: 'pay_1', status: 'paid' },
    });
    expect(notifications.emit).toHaveBeenCalledWith(
      'usr_1',
      expect.objectContaining({ type: 'ORDER_PAID' }),
    );
  });

  it('markPaid is idempotent — already-paid payment emits nothing', async () => {
    prisma.payment.findUnique.mockResolvedValue({
      id: 'pay_1',
      orderId: 'ord_1',
      status: 'PAID',
      amountUzs: 215000,
      order: { userId: 'usr_1' },
    });

    await svc.markPaid('pay_1');

    expect(realtime.emit).not.toHaveBeenCalled();
    expect(notifications.emit).not.toHaveBeenCalled();
  });
});
