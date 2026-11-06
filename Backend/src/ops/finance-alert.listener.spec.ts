// The money side's alerts reach the queue monitor's channels, under one subject.

import { AlertService } from './alert.service';
import { FinanceAlertListener } from './finance-alert.listener';
import { FinanceAlerts } from '../orders/finance-alerts';

describe('FinanceAlertListener', () => {
  it('raises each finance alert through the ops alert service, as `payments`', async () => {
    const ops = { raise: jest.fn().mockResolvedValue(true) };
    const listener = new FinanceAlertListener(ops as unknown as AlertService);

    await listener.handle({
      type: 'fiscal_receipt_failed',
      severity: 'critical',
      message: 'The PERFORM receipt of payment pay_1 was not accepted.',
      context: { paymentId: 'pay_1', orderId: 'ord_1', statusCode: 3 },
    });

    expect(ops.raise).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'fiscal_receipt_failed',
        severity: 'critical',
        queue: 'payments',
        context: { paymentId: 'pay_1', orderId: 'ord_1', statusCode: 3 },
      }),
    );
  });
});

describe('FinanceAlerts', () => {
  it('hands an alert on, and never throws when nothing listens', () => {
    const events = { emit: jest.fn() };
    new FinanceAlerts(events as never).raise({
      type: 'refund_refused',
      severity: 'critical',
      message: 'x',
      context: {},
    });
    expect(events.emit).toHaveBeenCalledWith(
      'finance.alert',
      expect.objectContaining({ type: 'refund_refused' }),
    );

    expect(() =>
      new FinanceAlerts().raise({
        type: 'refund_refused',
        severity: 'warning',
        message: 'x',
        context: {},
      }),
    ).not.toThrow();
  });
});
