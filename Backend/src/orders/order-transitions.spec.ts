import { OrderStatus } from '@prisma/client';
import {
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

  it('covers every OrderStatus', () => {
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual(
      Object.values(OrderStatus).sort(),
    );
  });
});
