import { NotificationType } from '@prisma/client';
import { BookingHoldSweeper } from './booking-sweeper.service';

describe('BookingHoldSweeper', () => {
  function build(expired: { id: string; userId: string }[], emit = jest.fn(async () => ({}))) {
    const prisma = { booking: { updateMany: jest.fn(async () => ({ count: 0 })) } };
    const orderStatus = { expireOverdue: jest.fn(async () => expired) };
    const notifications = { emit };
    const sweeper = new BookingHoldSweeper(prisma as any, orderStatus as any, notifications as any);
    return { sweeper, notifications };
  }

  it('tells each buyer whose unpaid order expired', async () => {
    const { sweeper, notifications } = build([
      { id: 'o1', userId: 'u1' },
      { id: 'o2', userId: 'u2' },
    ]);
    await sweeper.sweep();
    expect(notifications.emit).toHaveBeenCalledTimes(2);
    expect(notifications.emit).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({
        type: NotificationType.ORDER_STATUS_CHANGED,
        data: { order_id: 'o1', status: 'expired' },
      }),
    );
  });

  it('a failing notification does not stop the others', async () => {
    const emit = jest.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue({});
    const { sweeper } = build(
      [
        { id: 'o1', userId: 'u1' },
        { id: 'o2', userId: 'u2' },
      ],
      emit,
    );
    await expect(sweeper.sweep()).resolves.toBeUndefined();
    expect(emit).toHaveBeenCalledTimes(2);
  });
});
