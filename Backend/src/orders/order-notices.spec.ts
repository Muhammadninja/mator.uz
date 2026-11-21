import { EventEmitter2 } from '@nestjs/event-emitter';
import { ORDER_NOTICE_EVENT, OrderNotices } from './order-notices';

// Raised from checkout and from the payment callbacks, after their commit: it must never
// throw into them (a payment callback that failed here would be retried by Payme for a
// payment that already succeeded).
describe('OrderNotices', () => {
  it('raises one event per call, naming the order and why', () => {
    const events = new EventEmitter2();
    const seen: unknown[] = [];
    events.on(ORDER_NOTICE_EVENT, (notice) => seen.push(notice));
    const notices = new OrderNotices(events);

    notices.placed('ord_1');
    notices.paid('ord_2');

    expect(seen).toEqual([
      { orderId: 'ord_1', trigger: 'placed' },
      { orderId: 'ord_2', trigger: 'paid' },
    ]);
  });

  it('never throws, even when a listener does', () => {
    const events = new EventEmitter2();
    events.on(ORDER_NOTICE_EVENT, () => {
      throw new Error('listener exploded');
    });
    const notices = new OrderNotices(events);
    jest
      .spyOn(
        (notices as unknown as { logger: { error: () => void } }).logger,
        'error',
      )
      .mockImplementation(() => undefined);

    expect(() => notices.paid('ord_1')).not.toThrow();
  });

  it('does nothing with no event bus (a unit-test build)', () => {
    expect(() => new OrderNotices().placed('ord_1')).not.toThrow();
  });
});
