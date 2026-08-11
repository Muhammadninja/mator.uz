import {
  allocatePromoDiscount,
  splitEvenLines,
  AllocatableLine,
} from './promo-allocation.util';

/** A line in TIYIN, the unit the allocator works in throughout. */
const line = (
  id: string,
  unitPriceTiyin: number,
  quantity = 1,
): AllocatableLine => ({ id, unitPriceTiyin, quantity });

/** What the lines add up to before any discount. */
const subtotalOf = (lines: AllocatableLine[]) =>
  lines.reduce((s, l) => s + l.unitPriceTiyin * l.quantity, 0);

/**
 * The property that matters, asserted the same way everywhere: the discounted
 * line totals must land EXACTLY on `subtotal − discount`. This is the equality
 * Payme re-checks against the charged amount, so "off by one tiyin" is a failed
 * payment, not a rounding nicety.
 */
const expectExact = (lines: AllocatableLine[], discountTiyin: number) => {
  const allocation = allocatePromoDiscount(lines, discountTiyin);
  const allocated = [...allocation.values()];
  const sum = allocated.reduce((s, a) => s + a.effectiveLineTotalTiyin, 0);
  expect(sum).toBe(subtotalOf(lines) - discountTiyin);
  return allocation;
};

describe('allocatePromoDiscount', () => {
  it('takes the whole discount off a single-item order', () => {
    const lines = [line('a', 150_000_00)];
    const allocation = expectExact(lines, 15_000_00);

    expect(allocation.get('a')).toEqual({
      discountTiyin: 15_000_00,
      effectiveLineTotalTiyin: 135_000_00,
      effectiveUnitPriceTiyin: 135_000_00,
    });
  });

  it('splits pro rata across lines of uneven value', () => {
    // 300 000 + 100 000 = 400 000 tiyin of goods, 40 000 off: the dearer line
    // carries three quarters of the discount because it is three quarters of
    // the order — not half, which an even split would have given it.
    const lines = [line('big', 300_000), line('small', 100_000)];
    const allocation = expectExact(lines, 40_000);

    expect(allocation.get('big')?.discountTiyin).toBe(30_000);
    expect(allocation.get('small')?.discountTiyin).toBe(10_000);
  });

  it('gives the flooring remainder to the highest-value line', () => {
    // Three equal lines and 100 tiyin: 100/3 floors to 33 each, leaving 1 tiyin
    // that has to go somewhere or the receipt is short.
    const lines = [line('a', 1000), line('b', 1000), line('c', 1000)];
    const allocation = expectExact(lines, 100);

    // Ties break by input order, so the first line takes the stray tiyin.
    expect(allocation.get('a')?.discountTiyin).toBe(34);
    expect(allocation.get('b')?.discountTiyin).toBe(33);
    expect(allocation.get('c')?.discountTiyin).toBe(33);
  });

  it('puts the remainder on the DEAREST line, not the first one', () => {
    const lines = [line('cheap', 1000), line('dear', 2000), line('mid', 1500)];
    const allocation = expectExact(lines, 101);

    // Every line floors down; the leftover lands on `dear` because it is the
    // largest, wherever it sits in the input.
    expect(allocation.get('dear')?.discountTiyin).toBeGreaterThan(
      Math.floor((101 * 2000) / 4500),
    );
  });

  it('stays exact across a spread of awkward divisions', () => {
    // The remainder logic is only interesting when nothing divides evenly, so
    // sweep prices and discounts that are mutually prime-ish.
    for (const discount of [1, 7, 33, 99, 100, 1013, 7777]) {
      expectExact(
        [line('a', 3331), line('b', 7919, 3), line('c', 104729, 2)],
        discount,
      );
    }
  });

  it('never pushes a line below zero, even when the discount is the whole order', () => {
    const lines = [line('a', 5000), line('b', 3000)];
    const allocation = expectExact(lines, 8000);

    for (const a of allocation.values()) {
      expect(a.effectiveLineTotalTiyin).toBe(0);
    }
  });

  it('caps a discount larger than the order at the subtotal', () => {
    // A promo bigger than the cart cannot make the order owe the customer money.
    const lines = [line('a', 5000)];
    const allocation = allocatePromoDiscount(lines, 999_999);

    expect(allocation.get('a')?.discountTiyin).toBe(5000);
    expect(allocation.get('a')?.effectiveLineTotalTiyin).toBe(0);
  });

  it('leaves prices untouched when there is no promo', () => {
    const lines = [line('a', 5000, 2)];
    const allocation = allocatePromoDiscount(lines, 0);

    expect(allocation.get('a')).toEqual({
      discountTiyin: 0,
      effectiveLineTotalTiyin: 10_000,
      effectiveUnitPriceTiyin: 5000,
    });
  });

  it('handles a zero-value order without dividing by zero', () => {
    const allocation = allocatePromoDiscount([line('free', 0, 2)], 5000);
    expect(allocation.get('free')?.discountTiyin).toBe(0);
    expect(allocation.get('free')?.effectiveLineTotalTiyin).toBe(0);
  });

  it('weights a multi-unit line by its TOTAL, not its unit price', () => {
    // 1 × 1000 vs 4 × 500: the second line is the larger share of the order
    // even though its unit price is lower, and must absorb more of the discount.
    const lines = [line('one', 1000), line('four', 500, 4)];
    const allocation = expectExact(lines, 300);

    expect(allocation.get('one')?.discountTiyin).toBe(100);
    expect(allocation.get('four')?.discountTiyin).toBe(200);
  });
});

describe('splitEvenLines', () => {
  it('returns a single line when the total divides evenly', () => {
    expect(splitEvenLines(30_000, 3)).toEqual([
      { unitPriceTiyin: 10_000, count: 3 },
    ]);
  });

  it('splits an uneven total so price × count is still exact', () => {
    // 100 000 over 3 units is 33 333⅓ — no integer unit price expresses it, so
    // one unit pays the extra tiyin.
    const split = splitEvenLines(100_000, 3);

    expect(split).toEqual([
      { unitPriceTiyin: 33_334, count: 1 },
      { unitPriceTiyin: 33_333, count: 2 },
    ]);
    const total = split.reduce((s, l) => s + l.unitPriceTiyin * l.count, 0);
    expect(total).toBe(100_000);
  });

  it('reconstructs the total exactly for every remainder', () => {
    for (let count = 1; count <= 12; count++) {
      for (const total of [0, 1, 99, 100_000, 999_983]) {
        const sum = splitEvenLines(total, count).reduce(
          (s, l) => s + l.unitPriceTiyin * l.count,
          0,
        );
        expect(sum).toBe(total);
      }
    }
  });

  it('preserves the unit count across the split', () => {
    for (let count = 1; count <= 12; count++) {
      const units = splitEvenLines(100_001, count).reduce(
        (s, l) => s + l.count,
        0,
      );
      expect(units).toBe(count);
    }
  });

  it('returns nothing for a line of no units', () => {
    expect(splitEvenLines(1000, 0)).toEqual([]);
  });
});

/**
 * The end-to-end money question, in the units the order actually stores: a cart
 * priced in UZS, a promo, delivery and a service fee — does the customer get
 * charged exactly what the lines say?
 */
describe('order-level arithmetic (items + delivery + service fee + promo)', () => {
  it('makes the discounted lines plus fees equal the charged total', () => {
    // Three lines, deliberately awkward: 149 900 ×1, 32 500 ×3, 8 750 ×2.
    const lines = [
      line('a', 149_900_00),
      line('b', 32_500_00, 3),
      line('c', 8_750_00, 2),
    ];
    const subtotal = subtotalOf(lines); // tiyin
    const discount = Math.round(subtotal * 0.1); // a 10% promo, as resolvePromo does
    const deliveryTiyin = 25_000_00;
    const serviceFeeTiyin = 5_000_00;

    const allocation = expectExact(lines, discount);

    // What the receipt will carry: each line split into integer unit prices,
    // plus the two platform charges.
    const receipt = [...allocation.values()].flatMap((a, i) =>
      splitEvenLines(a.effectiveLineTotalTiyin, lines[i].quantity),
    );
    const receiptTotal =
      receipt.reduce((s, l) => s + l.unitPriceTiyin * l.count, 0) +
      deliveryTiyin +
      serviceFeeTiyin;

    // The amount the customer is charged, computed the way OrdersService does.
    const chargedTiyin = subtotal - discount + deliveryTiyin + serviceFeeTiyin;

    expect(receiptTotal).toBe(chargedTiyin);
  });
});
