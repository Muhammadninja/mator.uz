// Whether a refund has a tax receipt to show for it. An entry in the registry is never a
// receipt by itself: a refund outside Payme, and so every partial refund, needs Mator's own.

import { RefundMethod } from '@prisma/client';
import { refundFiscalStatus } from './admin-refunds.presenter';

type Refund = Parameters<typeof refundFiscalStatus>[0];
type Status = ReturnType<typeof refundFiscalStatus>;

const AT = new Date('2026-11-01T10:00:00Z');
const cancelReceipt = (statusCode: number | null) => ({
  receiptId: 'R-101',
  statusCode,
});

/** What the status reads of a refund: here money back in cash, and nothing else said. */
const refund = (over: Partial<Refund>): Refund => ({
  method: RefundMethod.CASH,
  providerConfirmedAt: null,
  fiscalReference: null,
  payment: { fiscalReceipts: [] },
  ...over,
});

describe('refundFiscalStatus: an entry in the registry is never a receipt by itself', () => {
  it.each<[string, Partial<Refund>, Status]>([
    [
      'a partial refund in cash, with nobody naming its receipt',
      {},
      { status: 'missing', receiptId: null },
    ],
    [
      'a refund on a terminal',
      { method: RefundMethod.TERMINAL },
      { status: 'missing', receiptId: null },
    ],
    [
      'a bank transfer',
      { method: RefundMethod.BANK_TRANSFER },
      { status: 'missing', receiptId: null },
    ],
    [
      'cash, with the return receipt an operator recorded',
      { fiscalReference: 'OFD-555' },
      { status: 'stated_by_operator', receiptId: 'OFD-555' },
    ],
    [
      'through Payme, before Payme reversed the payment, whatever receipt the payment has',
      {
        method: RefundMethod.PROVIDER,
        payment: { fiscalReceipts: [cancelReceipt(0)] },
      },
      { status: 'awaiting_payme', receiptId: null },
    ],
    [
      'reversed by Payme, its cancellation receipt not reported yet',
      { method: RefundMethod.PROVIDER, providerConfirmedAt: AT },
      { status: 'awaiting_payme', receiptId: null },
    ],
    [
      'reversed by Payme, its cancellation receipt pending at the tax authority',
      {
        method: RefundMethod.PROVIDER,
        providerConfirmedAt: AT,
        payment: { fiscalReceipts: [cancelReceipt(null)] },
      },
      { status: 'awaiting_payme', receiptId: 'R-101' },
    ],
    [
      'reversed by Payme, its cancellation receipt accepted',
      {
        method: RefundMethod.PROVIDER,
        providerConfirmedAt: AT,
        payment: { fiscalReceipts: [cancelReceipt(0)] },
      },
      { status: 'accepted', receiptId: 'R-101' },
    ],
    [
      'reversed by Payme, its cancellation receipt refused',
      {
        method: RefundMethod.PROVIDER,
        providerConfirmedAt: AT,
        payment: { fiscalReceipts: [cancelReceipt(3)] },
      },
      { status: 'rejected', receiptId: 'R-101' },
    ],
  ])('%s', (_label, over, expected) => {
    expect(refundFiscalStatus(refund(over))).toEqual(expected);
  });
});
