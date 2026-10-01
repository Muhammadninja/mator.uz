import { OrderStatus } from '@prisma/client';
import {
  ACTIVE_ORDER_STATUSES,
  ALLOWED_TRANSITIONS,
  PAYABLE_ORDER_STATUSES,
  canTransition,
  isPayableOrderStatus,
} from './order-transitions';

describe('order-transitions (single source of truth)', () => {
  it('a payment may settle ONLY a PENDING_PAYMENT order (derived from the table)', () => {
    expect(PAYABLE_ORDER_STATUSES).toEqual([OrderStatus.PENDING_PAYMENT]);
  });

  it.each([
    OrderStatus.PAID,
    OrderStatus.PROCESSING,
    OrderStatus.SHIPPED,
    OrderStatus.DELIVERED,
    OrderStatus.CANCELLED,
    OrderStatus.REFUNDED,
    OrderStatus.EXPIRED,
  ])('%s is not payable', (status) => {
    expect(isPayableOrderStatus(status)).toBe(false);
  });

  it('staying put is not a transition; terminal states go nowhere', () => {
    expect(canTransition(OrderStatus.PAID, OrderStatus.PAID)).toBe(false);
    expect(ALLOWED_TRANSITIONS[OrderStatus.CANCELLED]).toEqual([]);
    expect(canTransition(OrderStatus.CANCELLED, OrderStatus.PAID)).toBe(false);
  });

  it('active (in-progress) orders = exactly the non-terminal statuses', () => {
    expect([...ACTIVE_ORDER_STATUSES].sort()).toEqual(
      [
        OrderStatus.PENDING_PAYMENT,
        OrderStatus.PAID,
        OrderStatus.PROCESSING,
        OrderStatus.SHIPPED,
      ].sort(),
    );
    for (const s of Object.values(OrderStatus)) {
      expect(ACTIVE_ORDER_STATUSES.includes(s)).toBe(
        ALLOWED_TRANSITIONS[s].length > 0,
      );
    }
  });

  it('covers every OrderStatus', () => {
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual(
      Object.values(OrderStatus).sort(),
    );
  });
});
