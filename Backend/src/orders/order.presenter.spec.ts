import { OrderStatus } from '@prisma/client';
import { ACTIVE_PROVIDER_STATE } from './order-status.service';
import {
  ORDER_INCLUDE,
  isExpirySuspended,
  presentOrder,
} from './order.presenter';

function order(over: Record<string, unknown> = {}) {
  return {
    id: 'ord_1',
    status: OrderStatus.PENDING_PAYMENT,
    subtotalUzs: 100_000,
    deliveryUzs: 0,
    serviceFeeUzs: 0,
    discountUzs: 0,
    totalUzs: 100_000,
    currency: 'UZS',
    vehicleId: null,
    deliveryAddressId: null,
    deliveryMethod: null,
    paymentType: 'PAYME',
    items: [],
    payments: [],
    expiresAt: new Date('2026-11-12T10:30:00Z'),
    createdAt: new Date('2026-11-12T10:00:00Z'),
    updatedAt: new Date('2026-11-12T10:00:00Z'),
    ...over,
  } as never;
}

describe('order presenter: payment window', () => {
  it('loads only open provider transactions, one row at most', () => {
    expect(ORDER_INCLUDE.payments).toEqual({
      where: { providerState: ACTIVE_PROVIDER_STATE },
      select: { id: true },
      take: 1,
    });
  });

  it('an unpaid order with no open transaction expires at expires_at', () => {
    const view = presentOrder(order());
    expect(view.expires_at).toBe('2026-11-12T10:30:00.000Z');
    expect(view.expiry_suspended).toBe(false);
  });

  it('an open Payme transaction suspends expiry, as the sweep does', () => {
    expect(
      presentOrder(order({ payments: [{ id: 'pay_1' }] })).expiry_suspended,
    ).toBe(true);
  });

  it('only an unpaid order can be suspended', () => {
    expect(
      isExpirySuspended({
        status: OrderStatus.PAID,
        payments: [{ id: 'pay_1' }],
      }),
    ).toBe(false);
  });

  it('a row loaded without payments counts as no open transaction', () => {
    expect(presentOrder(order({ payments: undefined })).expiry_suspended).toBe(
      false,
    );
  });
});
