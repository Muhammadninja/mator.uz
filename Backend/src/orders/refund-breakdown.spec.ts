// What a refund gives back of each kind of money, and what can never go back twice.

import { Prisma } from '@prisma/client';
import {
  checkStatedBreakdown,
  deriveBreakdown,
  readComponents,
  remainingOf,
  type ComponentEntry,
} from './refund-breakdown';

const D = (n: number) => new Prisma.Decimal(n);

/** 350 000 of dealer A's goods, 250 000 of dealer B's, a 20 000 fee, 25 000 of delivery. */
const ORDER = {
  totalUzs: 645_000,
  serviceFeeUzs: 20_000,
  deliveryUzs: 25_000,
  items: [
    { sellerId: 'dealer_a', lineTotalUzs: 300_000 },
    { sellerId: 'dealer_b', lineTotalUzs: 250_000 },
    { sellerId: 'dealer_a', lineTotalUzs: 50_000 },
  ],
};

const entry = (over: Partial<ComponentEntry> = {}): ComponentEntry => ({
  amountUzs: 0,
  serviceFeeUzs: 0,
  deliveryUzs: 0,
  allocations: [],
  ...over,
});

const components = (entries: ComponentEntry[] = [], everythingBack = false) =>
  readComponents({ order: ORDER, entries, tookMoney: true, everythingBack });

const plain = (c: ReturnType<typeof components>) => ({
  fee: Number(c.serviceFee.remaining),
  delivery: Number(c.delivery.remaining),
  sellers: Object.fromEntries(
    c.sellers.map((s) => [s.sellerId, Number(s.remaining)]),
  ),
  unattributed: Number(c.unattributed.remaining),
});

describe('readComponents', () => {
  it('splits what the order took by whose it is, adding up to its total', () => {
    const c = components();
    expect(plain(c)).toEqual({
      fee: 20_000,
      delivery: 25_000,
      sellers: { dealer_a: 350_000, dealer_b: 250_000 },
      unattributed: 0,
    });
    expect(Number(remainingOf(c))).toBe(645_000);
  });

  it('takes off what each entry gave back of each kind', () => {
    const c = components([
      entry({
        amountUzs: 105_000,
        deliveryUzs: 5_000,
        allocations: [{ sellerId: 'dealer_a', amountUzs: 100_000 }],
      }),
    ]);
    expect(plain(c)).toEqual({
      fee: 20_000,
      delivery: 20_000,
      sellers: { dealer_a: 250_000, dealer_b: 250_000 },
      unattributed: 0,
    });
  });

  it('nothing of any kind when the order took nothing', () => {
    const c = readComponents({
      order: ORDER,
      entries: [],
      tookMoney: false,
      everythingBack: false,
    });
    expect(Number(remainingOf(c))).toBe(0);
  });

  it('everything back means every part back, whatever the entries say', () => {
    expect(Number(remainingOf(components([], true)))).toBe(0);
  });

  it('goods no line names a seller for are still goods that can go back', () => {
    const c = readComponents({
      order: { totalUzs: 100_000, serviceFeeUzs: 0, deliveryUzs: 0, items: [] },
      entries: [],
      tookMoney: true,
      everythingBack: false,
    });
    expect(Number(c.unattributed.remaining)).toBe(100_000);
  });
});

describe('deriveBreakdown — a provider reversal, or all that is left', () => {
  it('takes everything of every kind', () => {
    const b = deriveBreakdown(components(), D(645_000));
    expect({
      fee: Number(b.serviceFeeUzs),
      delivery: Number(b.deliveryUzs),
      allocations: b.allocations.map((a) => [a.sellerId, Number(a.amountUzs)]),
      unattributed: Number(b.unattributedUzs),
    }).toEqual({
      fee: 20_000,
      delivery: 25_000,
      allocations: [
        ['dealer_a', 350_000],
        ['dealer_b', 250_000],
      ],
      unattributed: 0,
    });
  });

  it('after a partial refund, takes only what is left of each', () => {
    const c = components([
      entry({
        amountUzs: 100_000,
        allocations: [{ sellerId: 'dealer_b', amountUzs: 100_000 }],
      }),
    ]);
    const b = deriveBreakdown(c, D(545_000));
    expect(b.allocations.map((a) => [a.sellerId, Number(a.amountUzs)])).toEqual(
      [
        ['dealer_a', 350_000],
        ['dealer_b', 150_000],
      ],
    );
    expect(Number(b.serviceFeeUzs)).toBe(20_000);
  });
});

describe('checkStatedBreakdown — a refund an operator records', () => {
  const check = (
    amount: number,
    stated: Parameters<typeof checkStatedBreakdown>[2] = {},
    c = components(),
  ) => checkStatedBreakdown(c, D(amount), stated);
  const codeOf = (result: ReturnType<typeof check>) =>
    result.ok ? 'ok' : result.code;

  it('all that is left needs no breakdown', () => {
    const result = check(645_000);
    expect(result.ok).toBe(true);
  });

  it('a stated breakdown of all that is left has to agree with it', () => {
    expect(codeOf(check(645_000, { serviceFeeUzs: 0 }))).toBe(
      'REFUND_BREAKDOWN_MISMATCH',
    );
    expect(
      codeOf(
        check(645_000, {
          serviceFeeUzs: 20_000,
          deliveryUzs: 25_000,
          allocations: [
            { sellerId: 'dealer_b', amountUzs: 250_000 },
            { sellerId: 'dealer_a', amountUzs: 350_000 },
          ],
        }),
      ),
    ).toBe('ok');
  });

  it('one seller’s goods, said to be theirs', () => {
    const result = check(100_000, {
      allocations: [{ sellerId: 'dealer_b', amountUzs: 100_000 }],
    });
    expect(result.ok && result.breakdown.allocations).toEqual([
      { sellerId: 'dealer_b', amountUzs: D(100_000) },
    ]);
    expect(result.ok && Number(result.breakdown.serviceFeeUzs)).toBe(0);
  });

  it('with goods from two sellers, whose they were has to be said', () => {
    expect(codeOf(check(100_000))).toBe('REFUND_ALLOCATION_REQUIRED');
  });

  it('with goods from one seller only, there is nothing to say', () => {
    const single = readComponents({
      order: {
        ...ORDER,
        items: [{ sellerId: 'dealer_a', lineTotalUzs: 600_000 }],
      },
      entries: [],
      tookMoney: true,
      everythingBack: false,
    });
    const result = check(100_000, {}, single);
    expect(result.ok && result.breakdown.allocations).toEqual([
      { sellerId: 'dealer_a', amountUzs: D(100_000) },
    ]);
  });

  it('delivery and the fee go back only when said, and never past what they hold', () => {
    const result = check(45_000, {
      serviceFeeUzs: 20_000,
      deliveryUzs: 25_000,
    });
    expect(result.ok && result.breakdown.allocations).toEqual([]);
    expect(codeOf(check(30_000, { deliveryUzs: 30_000 }))).toBe(
      'REFUND_DELIVERY_EXCEEDS_CHARGED',
    );
    expect(codeOf(check(30_000, { serviceFeeUzs: 25_000 }))).toBe(
      'REFUND_FEE_EXCEEDS_CHARGED',
    );
  });

  it('no seller’s goods go back for more than they hold, or for a seller not on the order', () => {
    expect(
      codeOf(
        check(260_000, {
          allocations: [{ sellerId: 'dealer_b', amountUzs: 260_000 }],
        }),
      ),
    ).toBe('REFUND_ALLOCATION_INVALID');
    expect(
      codeOf(
        check(10_000, {
          allocations: [{ sellerId: 'dealer_x', amountUzs: 10_000 }],
        }),
      ),
    ).toBe('REFUND_ALLOCATION_INVALID');
    expect(
      codeOf(
        check(20_000, {
          allocations: [
            { sellerId: 'dealer_a', amountUzs: 10_000 },
            { sellerId: 'dealer_a', amountUzs: 10_000 },
          ],
        }),
      ),
    ).toBe('REFUND_ALLOCATION_INVALID');
  });

  it('the parts must add up to the amount', () => {
    expect(
      codeOf(
        check(100_000, {
          allocations: [{ sellerId: 'dealer_a', amountUzs: 90_000 }],
        }),
      ),
    ).toBe('REFUND_ALLOCATION_MISMATCH');
  });

  it('nothing goes back twice: what an earlier refund gave back is no longer there', () => {
    const after = components([
      entry({
        amountUzs: 250_000,
        allocations: [{ sellerId: 'dealer_b', amountUzs: 250_000 }],
      }),
    ]);
    expect(
      codeOf(
        check(
          1,
          { allocations: [{ sellerId: 'dealer_b', amountUzs: 1 }] },
          after,
        ),
      ),
    ).toBe('REFUND_ALLOCATION_INVALID');
    // …and with dealer B's goods gone, dealer A's are all the goods there are.
    const result = check(100_000, {}, after);
    expect(result.ok && result.breakdown.allocations).toEqual([
      { sellerId: 'dealer_a', amountUzs: D(100_000) },
    ]);
  });

  it('more than the goods can account for needs the fee and delivery stated', () => {
    const goodsOnly = components([
      entry({
        amountUzs: 600_000,
        allocations: [
          { sellerId: 'dealer_a', amountUzs: 350_000 },
          { sellerId: 'dealer_b', amountUzs: 250_000 },
        ],
      }),
    ]);
    expect(codeOf(check(20_000, {}, goodsOnly))).toBe(
      'REFUND_BREAKDOWN_REQUIRED',
    );
    expect(codeOf(check(20_000, { serviceFeeUzs: 20_000 }, goodsOnly))).toBe(
      'ok',
    );
  });

  it('no part can be negative', () => {
    expect(codeOf(check(10_000, { deliveryUzs: -1 }))).toBe(
      'REFUND_BREAKDOWN_INVALID',
    );
  });
});

describe('No commission: a seller’s goods are theirs in full', () => {
  const check = (
    amount: number,
    stated: Parameters<typeof checkStatedBreakdown>[2] = {},
  ) => checkStatedBreakdown(components(), D(amount), stated);

  it('a refund allocation is the goods amount and nothing else', () => {
    const result = check(100_000, {
      allocations: [{ sellerId: 'dealer_a', amountUzs: 100_000 }],
    });
    expect(result.ok && result.breakdown.allocations.map(Object.keys)).toEqual([
      ['sellerId', 'amountUzs'],
    ]);
    expect(Object.keys(components().sellers[0]).sort()).toEqual([
      'charged',
      'refunded',
      'remaining',
      'sellerId',
    ]);
  });

  it('one seller’s refund never touches another seller’s goods', () => {
    const after = components([
      entry({
        amountUzs: 50_000,
        allocations: [{ sellerId: 'dealer_b', amountUzs: 50_000 }],
      }),
    ]);
    expect(plain(after).sellers).toEqual({
      dealer_a: 350_000,
      dealer_b: 200_000,
    });
  });

  it('a partial refund of goods leaves the service fee and delivery with Mator', () => {
    const result = check(50_000, {
      allocations: [{ sellerId: 'dealer_b', amountUzs: 50_000 }],
    });
    expect(result.ok && Number(result.breakdown.serviceFeeUzs)).toBe(0);
    expect(result.ok && Number(result.breakdown.deliveryUzs)).toBe(0);
  });

  it('a reversal of everything gives each seller’s goods back in full, with the fee and delivery', () => {
    const b = deriveBreakdown(components(), D(645_000));
    expect(b.allocations.map((a) => [a.sellerId, Number(a.amountUzs)])).toEqual(
      [
        ['dealer_a', 350_000],
        ['dealer_b', 250_000],
      ],
    );
    expect(Number(b.serviceFeeUzs)).toBe(20_000);
    expect(Number(b.deliveryUzs)).toBe(25_000);
  });
});
