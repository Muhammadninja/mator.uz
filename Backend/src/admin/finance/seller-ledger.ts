import { OrderStatus, Prisma, RefundMethod } from '@prisma/client';
import type { SellerBalance } from './admin-finance.presenter';

/**
 * What each seller is owed, from the order lines, the refund allocations and the payouts. Read
 * in the database, grouped, so it stays true past a page of orders.
 *
 *   earned   = their goods on orders that took money − what refunds gave back of those goods
 *   payable  = the same, counting only orders a seller can be paid for (see PAYABLE_ORDER)
 *   blocked  = the same, counting only orders held back from payouts (see BLOCKED_ORDER)
 *   pending  = earned − payable − blocked: orders not delivered yet, with nothing holding them
 *   owed     = earned − paid out (below zero: Mator sent more than the seller earned)
 *   payable now = payable − paid out, never below zero
 *   debt     = paid out − payable, when that is above zero
 *
 * Mator takes no commission from sellers: a seller earns their goods as charged, so net of a
 * promo, in full. Delivery and the service fee are never a seller's: they are on no line. A
 * refund after a payout leaves a debt, which later earnings pay off before anything more can be
 * sent. One seller's refund touches only that seller's allocation rows.
 */

/**
 * An order that took the buyer's money at some point. Every way of being paid writes PAID to
 * the order's history (a Payme payment, an operator confirming cash or a terminal), and a
 * refund leaves it there, so this is "took money" whatever happened since.
 */
export const TOOK_MONEY: Prisma.OrderWhereInput = {
  statusHistory: { some: { status: OrderStatus.PAID } },
};

/** A refund through the provider that the provider has not confirmed yet. */
const UNCONFIRMED_PROVIDER_REFUND: Prisma.FinancialRefundWhereInput = {
  voidedAt: null,
  method: RefundMethod.PROVIDER,
  providerConfirmedAt: null,
};

/**
 * The orders a seller can be paid for: the buyer has the goods (DELIVERED, which no order
 * leaves), the money came in, and nothing about it is unfinished — no hold for a cancellation
 * or return under way, and no refund through the provider that it has not confirmed yet.
 */
export const PAYABLE_ORDER: Prisma.OrderWhereInput = {
  ...TOOK_MONEY,
  status: OrderStatus.DELIVERED,
  payoutHoldAt: null,
  financialRefunds: { none: UNCONFIRMED_PROVIDER_REFUND },
};

/**
 * The orders held back from payouts, whatever their status: an operator's hold for a
 * cancellation or return under way, or a refund through the provider it has not confirmed.
 * Together with PAYABLE_ORDER and the orders still on their way, it splits every order that
 * took money three ways, with no order in two of them.
 */
export const BLOCKED_ORDER: Prisma.OrderWhereInput = {
  ...TOOK_MONEY,
  OR: [
    { payoutHoldAt: { not: null } },
    { financialRefunds: { some: UNCONFIRMED_PROVIDER_REFUND } },
  ],
};

type Client = Prisma.TransactionClient;
const ZERO = new Prisma.Decimal(0);

type Sums = Map<string, Prisma.Decimal>;
function bySeller(
  rows: { sellerId: string | null; amount: Prisma.Decimal | null }[],
): Sums {
  const out: Sums = new Map();
  for (const row of rows) {
    if (!row.sellerId) continue;
    out.set(row.sellerId, row.amount ?? ZERO);
  }
  return out;
}
const of = (sums: Sums, id: string) => sums.get(id) ?? ZERO;

export async function sellerNames(
  client: Pick<Client, 'catalogSeller'>,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await client.catalogSeller.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, name: true },
  });
  return new Map(rows.map((row) => [row.id, row.name]));
}

export async function sellerBalances(
  client: Client,
  sellerId?: string,
): Promise<SellerBalance[]> {
  const seller = sellerId ? { sellerId } : { sellerId: { not: null } };
  const one = sellerId ? { sellerId } : {};
  const lines = async (order: Prisma.OrderWhereInput) =>
    bySeller(
      (
        await client.orderItem.groupBy({
          by: ['sellerId'],
          where: { ...seller, order },
          _sum: { lineTotalUzs: true },
        })
      ).map((r) => ({ sellerId: r.sellerId, amount: r._sum.lineTotalUzs })),
    );
  const refunds = async (refund: Prisma.FinancialRefundWhereInput) =>
    bySeller(
      (
        await client.financialRefundAllocation.groupBy({
          by: ['sellerId'],
          where: { ...one, refund: { voidedAt: null, ...refund } },
          _sum: { amountUzs: true },
        })
      ).map((r) => ({ sellerId: r.sellerId, amount: r._sum.amountUzs })),
    );
  const [
    sold,
    soldPayable,
    soldBlocked,
    refunded,
    refundedPayable,
    refundedBlocked,
    paid,
  ] = await Promise.all([
    lines(TOOK_MONEY),
    lines(PAYABLE_ORDER),
    lines(BLOCKED_ORDER),
    refunds({}),
    refunds({ order: PAYABLE_ORDER }),
    refunds({ order: BLOCKED_ORDER }),
    client.sellerPayout
      .groupBy({
        by: ['sellerId'],
        where: { ...one, voidedAt: null },
        _sum: { amountUzs: true },
      })
      .then((rows) =>
        bySeller(
          rows.map((r) => ({ sellerId: r.sellerId, amount: r._sum.amountUzs })),
        ),
      ),
  ]);

  const ids = [...new Set([...sold.keys(), ...paid.keys()])];
  const names = await sellerNames(client, ids);
  return ids
    .map((id) => {
      const earned = of(sold, id).sub(of(refunded, id));
      const payable = of(soldPayable, id).sub(of(refundedPayable, id));
      const blocked = of(soldBlocked, id).sub(of(refundedBlocked, id));
      const paidOut = of(paid, id);
      const now = payable.sub(paidOut);
      return {
        sellerId: id,
        name: names.get(id) ?? null,
        soldUzs: Number(of(sold, id)),
        refundedUzs: Number(of(refunded, id)),
        earnedUzs: Number(earned),
        payableUzs: Number(payable),
        blockedUzs: Number(blocked),
        pendingUzs: Number(earned.sub(payable).sub(blocked)),
        paidOutUzs: Number(paidOut),
        owedUzs: Number(earned.sub(paidOut)),
        payableNowUzs: Number(now.gt(0) ? now : ZERO),
        debtUzs: Number(now.lt(0) ? now.neg() : ZERO),
      };
    })
    .sort(
      (a, b) => b.owedUzs - a.owedUzs || a.sellerId.localeCompare(b.sellerId),
    );
}
