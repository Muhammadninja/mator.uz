import { OrderStatus, Prisma, RefundMethod } from '@prisma/client';
import type { SellerBalance } from './admin-finance.presenter';

/**
 * What each seller is owed, from the order lines, the refund allocations and the payouts. Read
 * in the database, grouped, so it stays true past a page of orders.
 *
 *   earned   = their goods on orders that took money
 *            − what refunds gave back of those goods
 *            − Mator's commission, net of the commission that went back with refunds
 *   payable  = the same, counting only orders a seller can be paid for (see PAYABLE)
 *   owed     = earned − paid out (below zero: Mator sent more than the seller earned)
 *   payable now = payable − paid out, never below zero
 *   debt     = paid out − payable, when that is above zero
 *
 * A refund after a payout therefore leaves a debt, which later earnings pay off before anything
 * more can be sent. Delivery and the service fee are never a seller's: they are not on any
 * line. One seller's refund touches only that seller's allocation rows.
 */

/**
 * An order that took the buyer's money at some point. Every way of being paid writes PAID to
 * the order's history (a Payme payment, an operator confirming cash or a terminal), and a
 * refund leaves it there, so this is "took money" whatever happened since.
 */
export const TOOK_MONEY: Prisma.OrderWhereInput = {
  statusHistory: { some: { status: OrderStatus.PAID } },
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
  financialRefunds: {
    none: {
      voidedAt: null,
      method: RefundMethod.PROVIDER,
      providerConfirmedAt: null,
    },
  },
};

type Client = Prisma.TransactionClient;
const ZERO = new Prisma.Decimal(0);

type Sums = Map<string, { a: Prisma.Decimal; b: Prisma.Decimal }>;
function bySeller(
  rows: {
    sellerId: string | null;
    a: Prisma.Decimal | null;
    b?: Prisma.Decimal | null;
  }[],
): Sums {
  const out: Sums = new Map();
  for (const row of rows) {
    if (!row.sellerId) continue;
    out.set(row.sellerId, { a: row.a ?? ZERO, b: row.b ?? ZERO });
  }
  return out;
}
const of = (sums: Sums, id: string) => sums.get(id) ?? { a: ZERO, b: ZERO };

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
  const lines = (order: Prisma.OrderWhereInput) =>
    client.orderItem.groupBy({
      by: ['sellerId'],
      where: { ...seller, order },
      _sum: { lineTotalUzs: true, commissionUzs: true },
    });
  const refunds = (refund: Prisma.FinancialRefundWhereInput) =>
    client.financialRefundAllocation.groupBy({
      by: ['sellerId'],
      where: { ...one, refund: { voidedAt: null, ...refund } },
      _sum: { amountUzs: true, commissionUzs: true },
    });
  const [sold, soldPayable, refunded, refundedPayable, paid] =
    await Promise.all([
      lines(TOOK_MONEY),
      lines(PAYABLE_ORDER),
      refunds({}),
      refunds({ order: PAYABLE_ORDER }),
      client.sellerPayout.groupBy({
        by: ['sellerId'],
        where: { ...one, voidedAt: null },
        _sum: { amountUzs: true },
      }),
    ]);

  const lineSums = (rows: typeof sold) =>
    bySeller(
      rows.map((r) => ({
        sellerId: r.sellerId,
        a: r._sum.lineTotalUzs,
        b: r._sum.commissionUzs,
      })),
    );
  const refundSums = (rows: typeof refunded) =>
    bySeller(
      rows.map((r) => ({
        sellerId: r.sellerId,
        a: r._sum.amountUzs,
        b: r._sum.commissionUzs,
      })),
    );
  const soldBy = lineSums(sold);
  const soldPayableBy = lineSums(soldPayable);
  const refundedBy = refundSums(refunded);
  const refundedPayableBy = refundSums(refundedPayable);
  const paidBy = bySeller(
    paid.map((r) => ({ sellerId: r.sellerId, a: r._sum.amountUzs })),
  );

  const ids = [...new Set([...soldBy.keys(), ...paidBy.keys()])];
  const names = await sellerNames(client, ids);
  return ids
    .map((id) => {
      const s = of(soldBy, id);
      const r = of(refundedBy, id);
      const commission = s.b.sub(r.b);
      const earned = s.a.sub(r.a).sub(commission);
      const sp = of(soldPayableBy, id);
      const rp = of(refundedPayableBy, id);
      const payable = sp.a.sub(rp.a).sub(sp.b.sub(rp.b));
      const paidOut = of(paidBy, id).a;
      const now = payable.sub(paidOut);
      return {
        sellerId: id,
        name: names.get(id) ?? null,
        soldUzs: Number(s.a),
        refundedUzs: Number(r.a),
        commissionUzs: Number(commission),
        earnedUzs: Number(earned),
        payableUzs: Number(payable),
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
