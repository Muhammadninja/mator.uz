import { Payment, PaymentProvider, Prisma } from '@prisma/client';

/**
 * The Payme transactions in a window, as GetStatement reports them: every transaction Payme
 * created in it, whatever became of it, oldest first, as the Merchant API asks. An invoice no
 * transaction took has no create time, so it is not among them.
 *
 * One definition, read by the webhook's GetStatement and by the admin reconciliation, so the
 * list an operator checks against the registry is exactly the list Payme is given.
 */
export function paymeStatementQuery(from: bigint, to: bigint) {
  return {
    where: {
      provider: PaymentProvider.PAYME,
      providerTransactionId: { not: null },
      providerCreateTime: { gte: from, lte: to },
    },
    orderBy: [{ providerCreateTime: 'asc' }, { id: 'asc' }],
  } satisfies Prisma.PaymentFindManyArgs;
}

/** One transaction as GetStatement reports it. */
export function presentStatementTransaction(
  p: Pick<
    Payment,
    | 'id'
    | 'orderId'
    | 'providerTransactionId'
    | 'providerCreateTime'
    | 'providerPerformTime'
    | 'providerCancelTime'
    | 'providerState'
    | 'cancelReason'
    | 'amountTiyin'
  >,
  accountField: string,
) {
  return {
    id: p.providerTransactionId,
    time: Number(p.providerCreateTime ?? 0),
    amount: Number(p.amountTiyin ?? 0),
    account: { [accountField]: p.orderId },
    create_time: Number(p.providerCreateTime ?? 0),
    perform_time: Number(p.providerPerformTime ?? 0),
    cancel_time: Number(p.providerCancelTime ?? 0),
    transaction: p.id,
    state: p.providerState ?? 0,
    reason: p.cancelReason ?? null,
  };
}
