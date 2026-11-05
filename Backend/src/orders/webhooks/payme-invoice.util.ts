import { PaymentProvider, PaymentStatus, Prisma } from '@prisma/client';

/**
 * The Payme invoice a payment of this order would settle: the newest one no transaction
 * has taken, still inside its payment window, with its receipt frozen. There is one at
 * most, because creating an invoice reuses it, and an older row with no receipt (from
 * before receipts were frozen) is simply not one.
 *
 * The window is what bounds how old a receipt can get. It is the order's own, and an
 * order that is paid on delivery never expires, so without it such an order could hold
 * a receipt for as long as it stays open.
 *
 * The one definition, for the three calls that have to agree on it: POST /payme/invoices
 * deciding whether to freeze a receipt, CheckPerformTransaction handing it to Payme, and
 * CreateTransaction binding a transaction to it.
 */
export function findOpenPaymeInvoice(
  client: Pick<Prisma.TransactionClient, 'payment'>,
  orderId: string,
  now: Date = new Date(),
) {
  return client.payment.findFirst({
    where: {
      orderId,
      provider: PaymentProvider.PAYME,
      providerTransactionId: null,
      status: PaymentStatus.PENDING,
      fiscalSnapshot: { isNot: null },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: { createdAt: 'desc' },
    include: { fiscalSnapshot: true },
  });
}
