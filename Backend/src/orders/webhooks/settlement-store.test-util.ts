/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- an untyped in-memory Prisma stand-in by design (rows are loose records) */
/**
 * TEST-ONLY in-memory stand-in for the payment/order tables, used to exercise
 * settlement under CONCURRENT callbacks.
 *
 * What it models (and why that is the relevant behaviour):
 *  • Conditional `updateMany` re-checks its WHERE against the CURRENT row, the
 *    way PostgreSQL re-evaluates a blocked UPDATE once the earlier writer
 *    commits (READ COMMITTED + row lock).
 *  • Interactive `$transaction(fn)` calls are SERIALISED (one at a time), as
 *    two transactions updating the same payment row would be by its row lock,
 *    and a throw ROLLS BACK every write the callback made.
 *  • Every call yields to the event loop, so two callers genuinely interleave:
 *    both read "PENDING" before either transaction starts — the exact window
 *    the old read-then-write settlement raced in.
 *
 * It is NOT PostgreSQL: it proves the settlement logic is safe under these
 * semantics, not that the generated SQL behaves this way.
 */
import { OrderStatus, PaymentStatus } from '@prisma/client';

type Row = Record<string, any>;

const tick = () => new Promise<void>((r) => setImmediate(r));
const clone = <T>(v: T): T => structuredClone(v);

function statusMatches(status: string, filter: unknown): boolean {
  if (filter === undefined) return true;
  if (typeof filter === 'string') return status === filter;
  const f = filter as { in?: string[]; notIn?: string[] };
  if (f.in && !f.in.includes(status)) return false;
  if (f.notIn && f.notIn.includes(status)) return false;
  return true;
}

export function settlementStore(seed: { payments: Row[]; orders: Row[] }) {
  let payments = new Map(seed.payments.map((p) => [p.id, clone(p)]));
  let orders = new Map(seed.orders.map((o) => [o.id, clone(o)]));
  let history: Row[] = [];
  let txQueue: Promise<unknown> = Promise.resolve();

  const findPayment = (where: Row) => {
    if (where.id) return payments.get(where.id);
    const key = where.provider_providerTransactionId;
    return [...payments.values()].find(
      (p) =>
        p.provider === key.provider &&
        p.providerTransactionId === key.providerTransactionId,
    );
  };

  const api = {
    payment: {
      findUnique: async ({ where, include }: Row) => {
        await tick();
        const p = findPayment(where);
        if (!p) return null;
        return include?.order
          ? { ...clone(p), order: clone(orders.get(p.orderId)) }
          : clone(p);
      },
      updateMany: async ({ where, data }: Row) => {
        await tick();
        const p = payments.get(where.id);
        if (!p || !statusMatches(p.status, where.status)) return { count: 0 };
        Object.assign(p, data);
        return { count: 1 };
      },
    },
    order: {
      findUnique: async ({ where }: Row) => {
        await tick();
        const o = orders.get(where.id);
        return o ? clone(o) : null;
      },
      updateMany: async ({ where, data }: Row) => {
        await tick();
        const o = orders.get(where.id);
        if (!o || !statusMatches(o.status, where.status)) return { count: 0 };
        Object.assign(o, data);
        return { count: 1 };
      },
      update: async ({ where, data }: Row) => {
        await tick();
        Object.assign(orders.get(where.id)!, data);
        return clone(orders.get(where.id));
      },
    },
    orderStatusHistory: {
      create: async ({ data }: Row) => {
        await tick();
        history.push(clone(data));
        return data;
      },
    },
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => {
      const run = async () => {
        const saved = {
          payments: clone(payments),
          orders: clone(orders),
          history: clone(history),
        };
        try {
          return await fn(api);
        } catch (err) {
          payments = saved.payments;
          orders = saved.orders;
          history = saved.history;
          throw err;
        }
      };
      const result = txQueue.then(run, run);
      txQueue = result.catch(() => undefined);
      return result;
    },
  };

  return {
    prisma: api,
    payment: (id: string): Row => {
      const p = payments.get(id);
      if (!p) throw new Error(`settlement store: no payment ${id}`);
      return clone(p);
    },
    order: (id: string): Row => {
      const o = orders.get(id);
      if (!o) throw new Error(`settlement store: no order ${id}`);
      return clone(o);
    },
    history: () => clone(history),
  };
}

/** A state-1 Payme payment for `ord_1`, created just now. */
export function pendingPaymePayment(over: Row = {}): Row {
  return {
    id: 'pay_1',
    orderId: 'ord_1',
    provider: 'PAYME',
    status: PaymentStatus.PENDING,
    amountUzs: 215000,
    providerTransactionId: 'pmt-xyz',
    providerState: 1,
    providerCreateTime: BigInt(Date.now()),
    providerPerformTime: null,
    paidAt: null,
    ...over,
  };
}

export function order(status: OrderStatus, over: Row = {}): Row {
  return { id: 'ord_1', userId: 'usr_1', status, totalUzs: 215000, ...over };
}
