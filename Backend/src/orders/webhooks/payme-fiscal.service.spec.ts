// The Payme fiscal receipt: how an order's items become fiscal items, and the
// gate that refuses an order whose fiscal data is incomplete.
//
// Pins the mapping the integration depends on —
//   MXIK          → code
//   package code  → package_code   (by the listing's sale form)
//   dealer VAT    → vat_percent
//   dealer TIN    → commission_info.tin
//   (no `units`)
// — per ITEM, so one order spanning several dealers settles each line with its
// own dealer's tax data.

import { OilType, PackageForm, Prisma, ProductKind } from '@prisma/client';
import {
  FiscalDataIncompleteException,
  PaymeFiscalService,
} from './payme-fiscal.service';
import { buildFiscalItem, receiptTotalTiyin } from './payme-fiscal.util';
import { OIL_TYPE_FISCAL, OIL_TYPE_REQUIRED } from '../../common/fiscal.util';
import { CATEGORY_FISCAL_DATA } from '../../prisma/seed-data/catalog-reference.seed';
import {
  createPrismaMock,
  fakeConfig,
  PrismaMock,
} from '../../../test/utils/harness';

/** Brakes: MXIK plus both package codes (Штука / Комплект). */
const BRAKES = {
  mxik: '08708005011000000',
  packageCodeSingle: '1417722',
  packageCodeSet: '1417723',
};
/** Filters: one package code, so its sellers are never asked the question. */
const FILTERS = {
  mxik: '08421002001000000',
  packageCodeSingle: '1499205',
  packageCodeSet: null,
};

const DEALER_A = { tin: '301234567', vatPercent: new Prisma.Decimal(0) };
const DEALER_B = { tin: '209876543', vatPercent: new Prisma.Decimal(12) };

function orderItem(over: Record<string, unknown> = {}) {
  return {
    id: 'oi_1',
    partId: 'part_1',
    title: 'Тормозные колодки',
    quantity: 1,
    priceUzs: new Prisma.Decimal(150000),
    ...over,
  };
}

function catalogPart(over: Record<string, unknown> = {}) {
  return {
    id: 'part_1',
    packageForm: null,
    kind: ProductKind.SPARE_PART,
    oilType: null,
    category: BRAKES,
    seller: DEALER_A,
    ...over,
  };
}

/** The order's own charges, as `stub` applies them. */
interface OrderCharges {
  deliveryUzs?: number;
  serviceFeeUzs?: number;
  discountUzs?: number;
  /** Overrides the derived total — for testing a receipt that does NOT add up. */
  totalUzs?: number;
}

describe('PaymeFiscalService.buildOrderDetail', () => {
  let prisma: PrismaMock;
  let svc: PaymeFiscalService;

  beforeEach(() => {
    prisma = createPrismaMock();
    // No platform codes configured by default, so a test that adds a service
    // fee has to say so — the same position a fresh deployment is in.
    svc = new PaymeFiscalService(prisma, fakeConfig({}));
  });

  /**
   * Stub an order and its lines. The charged total is DERIVED from the stubbed
   * lines plus the order's charges, so every test starts from an order whose
   * receipt can add up; a test about mismatches overrides `totalUzs`.
   */
  const stub = (
    items: { priceUzs: Prisma.Decimal; quantity: number }[],
    parts: unknown[],
    charges: OrderCharges = {},
  ) => {
    const subtotal = items.reduce(
      (sum, i) => sum + Number(i.priceUzs) * i.quantity,
      0,
    );
    const delivery = charges.deliveryUzs ?? 0;
    const serviceFee = charges.serviceFeeUzs ?? 0;
    const discount = charges.discountUzs ?? 0;
    prisma.order.findUnique.mockResolvedValue({
      id: 'ord_1',
      totalUzs: new Prisma.Decimal(
        charges.totalUzs ?? subtotal + delivery + serviceFee - discount,
      ),
      deliveryUzs: new Prisma.Decimal(delivery),
      serviceFeeUzs: new Prisma.Decimal(serviceFee),
      discountUzs: new Prisma.Decimal(discount),
    });
    prisma.orderItem.findMany.mockResolvedValue(items);
    prisma.catalogPart.findMany.mockResolvedValue(parts);
  };

  it('takes the MXIK from the item’s CATEGORY', async () => {
    stub([orderItem()], [catalogPart()]);
    const detail = await svc.buildOrderDetail('ord_1');
    expect(detail?.items[0].code).toBe('08708005011000000');
  });

  it('takes package_code from the SELECTED sale form', async () => {
    stub([orderItem()], [catalogPart({ packageForm: PackageForm.SET })]);
    const detail = await svc.buildOrderDetail('ord_1');
    expect(detail?.items[0].package_code).toBe('1417723');

    stub([orderItem()], [catalogPart({ packageForm: PackageForm.SINGLE })]);
    expect((await svc.buildOrderDetail('ord_1'))?.items[0].package_code).toBe(
      '1417722',
    );
  });

  it('uses the single package code automatically when the category has only one', async () => {
    // No sale form was ever asked for (packageForm null) — the category's only
    // code applies with no per-product configuration.
    stub([orderItem()], [catalogPart({ category: FILTERS })]);
    const detail = await svc.buildOrderDetail('ord_1');
    expect(detail?.items[0].package_code).toBe('1499205');
  });

  it('takes vat_percent and commission_info.tin from the item’s DEALER', async () => {
    stub([orderItem()], [catalogPart({ seller: DEALER_B })]);
    const [item] = (await svc.buildOrderDetail('ord_1'))!.items;
    expect(item.vat_percent).toBe(12);
    expect(item.commission_info).toEqual({ tin: '209876543' });
  });

  it('never sends `units`', async () => {
    stub([orderItem()], [catalogPart()]);
    const [item] = (await svc.buildOrderDetail('ord_1'))!.items;
    expect(Object.keys(item).sort()).toEqual([
      'code',
      'commission_info',
      'count',
      'package_code',
      'price',
      'title',
      'vat_percent',
    ]);
    expect(item).not.toHaveProperty('units');
  });

  it('prices items in tiyin, per unit, with the line’s count', async () => {
    stub(
      [orderItem({ quantity: 3, priceUzs: new Prisma.Decimal(150000) })],
      [catalogPart()],
    );
    const [item] = (await svc.buildOrderDetail('ord_1'))!.items;
    expect(item.price).toBe(15_000_000);
    expect(item.count).toBe(3);
  });

  it('fiscalizes a MULTI-DEALER order with each item’s own VAT and TIN', async () => {
    stub(
      [
        orderItem({ id: 'oi_1', partId: 'part_a', title: 'Колодки' }),
        orderItem({ id: 'oi_2', partId: 'part_b', title: 'Фильтр' }),
      ],
      [
        catalogPart({
          id: 'part_a',
          seller: DEALER_A,
          category: BRAKES,
          packageForm: PackageForm.SET,
        }),
        catalogPart({ id: 'part_b', seller: DEALER_B, category: FILTERS }),
      ],
    );

    const detail = await svc.buildOrderDetail('ord_1');

    expect(detail?.items).toEqual([
      {
        title: 'Колодки',
        price: 15_000_000,
        count: 1,
        code: '08708005011000000',
        package_code: '1417723',
        vat_percent: 0,
        commission_info: { tin: '301234567' },
      },
      {
        title: 'Фильтр',
        price: 15_000_000,
        count: 1,
        code: '08421002001000000',
        package_code: '1499205',
        vat_percent: 12,
        commission_info: { tin: '209876543' },
      },
    ]);
  });

  it('does not let the FIRST dealer’s tax data leak onto another dealer’s line', async () => {
    stub(
      [
        orderItem({ id: 'oi_1', partId: 'part_a' }),
        orderItem({ id: 'oi_2', partId: 'part_b' }),
      ],
      [
        catalogPart({ id: 'part_a', seller: DEALER_A }),
        catalogPart({ id: 'part_b', seller: DEALER_B }),
      ],
    );
    const items = (await svc.buildOrderDetail('ord_1'))!.items;
    expect(items.map((i) => i.vat_percent)).toEqual([0, 12]);
    expect(items.map((i) => i.commission_info?.tin)).toEqual([
      '301234567',
      '209876543',
    ]);
  });

  it('marks the receipt as a sale', async () => {
    stub([orderItem()], [catalogPart()]);
    expect((await svc.buildOrderDetail('ord_1'))?.receipt_type).toBe(0);
  });

  // ── the gate ──────────────────────────────────────────────────────────────
  it('refuses an order whose dealer has no TIN', async () => {
    stub(
      [orderItem()],
      [
        catalogPart({
          seller: { tin: null, vatPercent: new Prisma.Decimal(12) },
        }),
      ],
    );
    await expect(svc.buildOrderDetail('ord_1')).rejects.toBeInstanceOf(
      FiscalDataIncompleteException,
    );
  });

  it('refuses an order whose dealer has no VAT percentage', async () => {
    stub(
      [orderItem()],
      [catalogPart({ seller: { tin: '301234567', vatPercent: null } })],
    );
    await expect(svc.buildOrderDetail('ord_1')).rejects.toBeInstanceOf(
      FiscalDataIncompleteException,
    );
  });

  it('treats a 0% dealer as configured — 0 is a rate, not a missing value', async () => {
    stub([orderItem()], [catalogPart({ seller: DEALER_A })]);
    await expect(svc.buildOrderDetail('ord_1')).resolves.toMatchObject({
      items: [expect.objectContaining({ vat_percent: 0 })],
    });
  });

  it('refuses an order whose category is not fiscally configured', async () => {
    stub(
      [orderItem()],
      [
        catalogPart({
          category: {
            mxik: null,
            packageCodeSingle: null,
            packageCodeSet: null,
          },
        }),
      ],
    );
    await expect(svc.buildOrderDetail('ord_1')).rejects.toBeInstanceOf(
      FiscalDataIncompleteException,
    );
  });

  it('refuses (never silently drops) a line whose catalog part is gone', async () => {
    stub([orderItem({ partId: 'part_missing' })], []);
    await expect(svc.buildOrderDetail('ord_1')).rejects.toBeInstanceOf(
      FiscalDataIncompleteException,
    );
  });

  it('tells the customer nothing about the internal gap', async () => {
    stub(
      [orderItem()],
      [catalogPart({ seller: { tin: null, vatPercent: null } })],
    );
    await expect(svc.buildOrderDetail('ord_1')).rejects.toThrow(
      /temporarily unavailable for online payment/,
    );
  });

  it('returns no receipt for an order with no product lines (services only)', async () => {
    stub([], []);
    await expect(svc.buildOrderDetail('ord_1')).resolves.toBeNull();
    // …and the checkout gate lets such an order through unchanged.
    await expect(svc.assertFiscalizable('ord_1')).resolves.toBeUndefined();
  });

  it('reads only PRODUCT lines of the order', async () => {
    stub([], []);
    await svc.buildOrderDetail('ord_9');
    expect(prisma.orderItem.findMany.mock.calls[0][0].where).toEqual({
      orderId: 'ord_9',
      partId: { not: null },
    });
  });
});

// ── Motor oil ────────────────────────────────────────────────────────────────
// Oil is classified by BASE COMPOSITION, not by category: one category, three
// MXIKs. The codes therefore come from the seller's OIL_TYPE answer, which is
// already projected onto the catalog row.
describe('motor-oil fiscal resolution', () => {
  let prisma: PrismaMock;
  let svc: PaymeFiscalService;

  beforeEach(() => {
    prisma = createPrismaMock();
    svc = new PaymeFiscalService(prisma, fakeConfig({}));
  });

  /** An oil listing under the oil category, which carries NO codes of its own. */
  const oilPart = (oilType: OilType | null) => ({
    id: 'part_1',
    packageForm: null,
    kind: ProductKind.MOTOR_OIL,
    oilType,
    category: { mxik: null, packageCodeSingle: null, packageCodeSet: null },
    seller: DEALER_B,
  });

  const stubOil = (oilType: OilType | null) => {
    prisma.order.findUnique.mockResolvedValue({
      id: 'ord_1',
      totalUzs: new Prisma.Decimal(450000),
      deliveryUzs: new Prisma.Decimal(0),
      serviceFeeUzs: new Prisma.Decimal(0),
      discountUzs: new Prisma.Decimal(0),
    });
    prisma.orderItem.findMany.mockResolvedValue([
      {
        id: 'oi_1',
        partId: 'part_1',
        title: 'Mobil 1 ESP 5W-30 4L',
        quantity: 1,
        priceUzs: new Prisma.Decimal(450000),
      },
    ]);
    prisma.catalogPart.findMany.mockResolvedValue([oilPart(oilType)]);
  };

  it.each([
    [OilType.SYNTHETIC, '02710005001000000', '1282037'],
    [OilType.SEMI_SYNTHETIC, '02710005002000000', '1282031'],
    [OilType.MINERAL, '02710005003000000', '1282581'],
  ])(
    'resolves %s to its own MXIK and package code',
    async (type, mxik, pkg) => {
      stubOil(type);
      const [item] = (await svc.buildOrderDetail('ord_1'))!.items;
      expect(item.code).toBe(mxik);
      expect(item.package_code).toBe(pkg);
    },
  );

  it('gives each oil type a DIFFERENT code — none stands in for another', () => {
    const codes = Object.values(OIL_TYPE_FISCAL);
    expect(new Set(codes.map((c) => c.mxik)).size).toBe(codes.length);
    expect(new Set(codes.map((c) => c.packageCode)).size).toBe(codes.length);
  });

  it('still takes VAT and TIN from the DEALER, like any other item', async () => {
    stubOil(OilType.SYNTHETIC);
    const [item] = (await svc.buildOrderDetail('ord_1'))!.items;
    expect(item.vat_percent).toBe(12);
    expect(item.commission_info).toEqual({ tin: '209876543' });
  });

  it('refuses an oil listing with no oil type, naming the reason', async () => {
    stubOil(null);
    await expect(svc.buildOrderDetail('ord_1')).rejects.toBeInstanceOf(
      FiscalDataIncompleteException,
    );
    await expect(svc.buildOrderDetail('ord_1')).rejects.toMatchObject({
      gaps: [expect.stringContaining(OIL_TYPE_REQUIRED)],
    });
  });

  it('ignores the category’s codes entirely for an oil listing', async () => {
    // Even a category that HAS codes must not fiscalize an oil: the three oil
    // types would all collapse onto one MXIK.
    prisma.order.findUnique.mockResolvedValue({
      id: 'ord_1',
      totalUzs: new Prisma.Decimal(450000),
      deliveryUzs: new Prisma.Decimal(0),
      serviceFeeUzs: new Prisma.Decimal(0),
      discountUzs: new Prisma.Decimal(0),
    });
    prisma.orderItem.findMany.mockResolvedValue([
      {
        id: 'oi_1',
        partId: 'part_1',
        title: 'ZIC X9',
        quantity: 1,
        priceUzs: new Prisma.Decimal(450000),
      },
    ]);
    prisma.catalogPart.findMany.mockResolvedValue([
      { ...oilPart(OilType.MINERAL), category: BRAKES },
    ]);

    const [item] = (await svc.buildOrderDetail('ord_1'))!.items;
    expect(item.code).toBe('02710005003000000');
    expect(item.package_code).toBe('1282581');
  });

  it('leaves a NON-oil listing on the category path', async () => {
    // The guard is the listing's kind, not the presence of an oil category.
    prisma.order.findUnique.mockResolvedValue({
      id: 'ord_1',
      totalUzs: new Prisma.Decimal(150000),
      deliveryUzs: new Prisma.Decimal(0),
      serviceFeeUzs: new Prisma.Decimal(0),
      discountUzs: new Prisma.Decimal(0),
    });
    prisma.orderItem.findMany.mockResolvedValue([
      {
        id: 'oi_1',
        partId: 'part_1',
        title: 'Колодки',
        quantity: 1,
        priceUzs: new Prisma.Decimal(150000),
      },
    ]);
    prisma.catalogPart.findMany.mockResolvedValue([
      {
        id: 'part_1',
        packageForm: null,
        kind: ProductKind.SPARE_PART,
        oilType: null,
        category: BRAKES,
        seller: DEALER_A,
      },
    ]);

    const [item] = (await svc.buildOrderDetail('ord_1'))!.items;
    expect(item.code).toBe('08708005011000000');
  });
});

// ── Delivery and the platform's own charges ──────────────────────────────────
// Payme reconciles a receipt against the amount charged, so every component of
// the order total needs a line — otherwise the receipt is short by the fees.
describe('platform charge lines', () => {
  let prisma: PrismaMock;

  /** A service with the platform codes a deployment would configure. */
  const withCodes = (env: Record<string, string> = {}) =>
    new PaymeFiscalService(
      prisma,
      fakeConfig({
        SERVICE_FEE_MXIK: '10307001001000000',
        SERVICE_FEE_PACKAGE_CODE: '1000001',
        ...env,
      }),
    );

  const product = {
    id: 'oi_1',
    partId: 'part_1',
    title: 'Колодки',
    quantity: 1,
    priceUzs: new Prisma.Decimal(150000),
  };

  const stubOrder = (charges: {
    deliveryUzs: number;
    serviceFeeUzs: number;
    discountUzs?: number;
    totalUzs?: number;
  }) => {
    const discount = charges.discountUzs ?? 0;
    prisma.order.findUnique.mockResolvedValue({
      id: 'ord_1',
      totalUzs: new Prisma.Decimal(
        charges.totalUzs ??
          150000 + charges.deliveryUzs + charges.serviceFeeUzs - discount,
      ),
      deliveryUzs: new Prisma.Decimal(charges.deliveryUzs),
      serviceFeeUzs: new Prisma.Decimal(charges.serviceFeeUzs),
      discountUzs: new Prisma.Decimal(discount),
    });
    prisma.orderItem.findMany.mockResolvedValue([product]);
    prisma.catalogPart.findMany.mockResolvedValue([
      {
        id: 'part_1',
        packageForm: null,
        kind: ProductKind.SPARE_PART,
        oilType: null,
        category: BRAKES,
        seller: DEALER_A,
      },
    ]);
  };

  beforeEach(() => {
    prisma = createPrismaMock();
  });

  it('appends a delivery line with the default courier codes', async () => {
    stubOrder({ deliveryUzs: 25000, serviceFeeUzs: 0 });
    const detail = await withCodes().buildOrderDetail('ord_1');

    expect(detail!.items).toHaveLength(2);
    expect(detail!.items[1]).toEqual({
      title: 'Услуга доставки',
      price: 2_500_000,
      count: 1,
      code: '05320001001000000',
      package_code: '1000000',
      vat_percent: 0,
    });
  });

  it('adds NO delivery line when there is no delivery fee (pickup)', async () => {
    stubOrder({ deliveryUzs: 0, serviceFeeUzs: 0 });
    const detail = await withCodes().buildOrderDetail('ord_1');
    expect(detail!.items).toHaveLength(1);
    expect(detail!.items.map((i) => i.title)).toEqual(['Колодки']);
  });

  it('takes the delivery codes and VAT from configuration', async () => {
    stubOrder({ deliveryUzs: 25000, serviceFeeUzs: 0 });
    const detail = await withCodes({
      DELIVERY_MXIK: '05320001002000000',
      DELIVERY_PACKAGE_CODE: '1500000',
      DELIVERY_VAT_PERCENT: '12',
    }).buildOrderDetail('ord_1');

    expect(detail!.items[1]).toMatchObject({
      code: '05320001002000000',
      package_code: '1500000',
      vat_percent: 12,
    });
  });

  it('attributes platform lines to the MARKETPLACE tin when configured', async () => {
    stubOrder({ deliveryUzs: 25000, serviceFeeUzs: 0 });
    const detail = await withCodes({
      MARKETPLACE_TIN: '123456789',
    }).buildOrderDetail('ord_1');

    expect(detail!.items[1].commission_info).toEqual({ tin: '123456789' });
    // The product line still settles to its own DEALER.
    expect(detail!.items[0].commission_info).toEqual({ tin: '301234567' });
  });

  it('omits commission_info on a platform line when no marketplace tin is set', async () => {
    stubOrder({ deliveryUzs: 25000, serviceFeeUzs: 0 });
    const detail = await withCodes().buildOrderDetail('ord_1');
    expect(detail!.items[1]).not.toHaveProperty('commission_info');
  });

  it('adds a service-fee line when the order carries one', async () => {
    stubOrder({ deliveryUzs: 25000, serviceFeeUzs: 5000 });
    const detail = await withCodes().buildOrderDetail('ord_1');

    expect(detail!.items.map((i) => i.title)).toEqual([
      'Колодки',
      'Услуга доставки',
      'Сервисный сбор',
    ]);
    expect(detail!.items[2]).toMatchObject({
      price: 500_000,
      count: 1,
      code: '10307001001000000',
      package_code: '1000001',
    });
  });

  it('refuses a service fee whose codes are not configured, naming the keys', async () => {
    stubOrder({ deliveryUzs: 25000, serviceFeeUzs: 5000 });
    const unconfigured = new PaymeFiscalService(prisma, fakeConfig({}));

    // Both halves of the missing pair are reported, each naming the env key an
    // operator has to set — one round trip, not two.
    await expect(unconfigured.buildOrderDetail('ord_1')).rejects.toMatchObject({
      gaps: [
        expect.stringContaining('SERVICE_FEE_MXIK'),
        expect.stringContaining('SERVICE_FEE_PACKAGE_CODE'),
      ],
    });
  });

  // ── the sum Payme itself checks ────────────────────────────────────────────
  it('makes products + delivery + fee add up to the charged amount', async () => {
    stubOrder({ deliveryUzs: 25000, serviceFeeUzs: 5000 });
    const detail = await withCodes().buildOrderDetail('ord_1');

    const receipt = receiptTotalTiyin(detail!.items);
    expect(receipt).toBe(18_000_000); // 150 000 + 25 000 + 5 000 UZS
    // …which is exactly the amount the checkout link and the webhook use.
    expect(receipt).toBe(Math.round((150000 + 25000 + 5000) * 100));
  });

  it('adds up for a multi-quantity line, where a line total is price × count', async () => {
    prisma.order.findUnique.mockResolvedValue({
      id: 'ord_1',
      totalUzs: new Prisma.Decimal(475000), // 3 × 150 000 + 25 000
      deliveryUzs: new Prisma.Decimal(25000),
      serviceFeeUzs: new Prisma.Decimal(0),
      discountUzs: new Prisma.Decimal(0),
    });
    prisma.orderItem.findMany.mockResolvedValue([{ ...product, quantity: 3 }]);
    prisma.catalogPart.findMany.mockResolvedValue([
      {
        id: 'part_1',
        packageForm: null,
        kind: ProductKind.SPARE_PART,
        oilType: null,
        category: BRAKES,
        seller: DEALER_A,
      },
    ]);

    const detail = await withCodes().buildOrderDetail('ord_1');
    expect(receiptTotalTiyin(detail!.items)).toBe(47_500_000);
  });

  it('refuses a receipt that does not add up to the charge', async () => {
    // A total that no combination of lines can reach — the case this check
    // exists to catch before Payme does.
    stubOrder({ deliveryUzs: 25000, serviceFeeUzs: 0, totalUzs: 999000 });

    await expect(withCodes().buildOrderDetail('ord_1')).rejects.toMatchObject({
      gaps: [expect.stringContaining('does not match the charged')],
    });
  });

  it('fiscalizes a promo-discounted order, the discount already in the prices', async () => {
    // The discount is embedded in the line prices at order creation, so by the
    // time the receipt is built the item IS the discounted item: 150 000 − 15 000
    // = 135 000 UZS of goods, plus 25 000 delivery, against a 160 000 charge.
    prisma.order.findUnique.mockResolvedValue({
      id: 'ord_1',
      totalUzs: new Prisma.Decimal(160000),
      deliveryUzs: new Prisma.Decimal(25000),
      serviceFeeUzs: new Prisma.Decimal(0),
      discountUzs: new Prisma.Decimal(15000),
    });
    prisma.orderItem.findMany.mockResolvedValue([
      { ...product, priceUzs: new Prisma.Decimal(135000), lineTotalUzs: new Prisma.Decimal(135000) },
    ]);
    prisma.catalogPart.findMany.mockResolvedValue([
      {
        id: 'part_1',
        packageForm: null,
        kind: ProductKind.SPARE_PART,
        oilType: null,
        category: BRAKES,
        seller: DEALER_A,
      },
    ]);

    const detail = await withCodes().buildOrderDetail('ord_1');
    expect(receiptTotalTiyin(detail!.items)).toBe(16_000_000);
  });

  it('leaves a services-only order unfiscalized rather than sending fees alone', async () => {
    // No product lines: the order predates fiscalization's reach, and a receipt
    // containing only a delivery fee would be neither complete nor reconcilable.
    prisma.order.findUnique.mockResolvedValue({
      id: 'ord_1',
      totalUzs: new Prisma.Decimal(25000),
      deliveryUzs: new Prisma.Decimal(25000),
      serviceFeeUzs: new Prisma.Decimal(0),
      discountUzs: new Prisma.Decimal(0),
    });
    prisma.orderItem.findMany.mockResolvedValue([]);

    await expect(withCodes().buildOrderDetail('ord_1')).resolves.toBeNull();
  });
});

describe('buildFiscalItem (pure mapping)', () => {
  const line = (over: Record<string, unknown> = {}) => ({
    reference: 'item oi_1',
    title: 'Колодки',
    quantity: 2,
    priceUzs: 150000,
    category: BRAKES,
    packageForm: null,
    kind: ProductKind.SPARE_PART,
    oilType: null,
    dealer: { tin: '301234567', vatPercent: 0 },
    ...over,
  });

  it('reports every missing fact at once, naming the line', () => {
    const result = buildFiscalItem(
      line({
        category: { mxik: null, packageCodeSingle: null, packageCodeSet: null },
        dealer: { tin: null, vatPercent: null },
      }) as never,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.gaps).toEqual([
      'item oi_1: category has no MXIK',
      'item oi_1: category has no package code',
      'item oi_1: dealer has no TIN',
      'item oi_1: dealer has no VAT percentage',
    ]);
  });

  it('rounds the tiyin amount the same way the payable amount is', () => {
    const result = buildFiscalItem(
      line({ priceUzs: 150000.005, quantity: 1 }) as never,
    );
    expect(result.ok && result.items).toEqual([
      expect.objectContaining({ price: 15_000_001, count: 1 }),
    ]);
  });

  // Where a listing's codes come from is decided by its KIND. Antifreeze is the
  // case that makes the rule visible: it lives one step away from motor oil in
  // the wizard, and the three oil MXIKs describe motor oil ONLY.
  describe("ANTIFREEZE keeps its own category's IKPU", () => {
    // The REAL operator-supplied codes of the `antifreeze` category, taken from
    // the seed's own table so this test and the configuration cannot drift.
    const ANTIFREEZE_CATEGORY = {
      mxik: CATEGORY_FISCAL_DATA.antifreeze.mxik,
      packageCodeSingle: CATEGORY_FISCAL_DATA.antifreeze.packageCodeSingle,
      packageCodeSet: null,
    };

    it("resolves to the antifreeze category's own configured codes", () => {
      // Pinned literally here, derived from the seed above — so a change to
      // either side fails rather than silently re-fiscalizing every antifreeze.
      expect(ANTIFREEZE_CATEGORY.mxik).toBe('03820001001000000');
      expect(ANTIFREEZE_CATEGORY.packageCodeSingle).toBe('1513835');
    });

    it('fiscalizes from the category, never from the oil table', () => {
      const result = buildFiscalItem(
        line({
          kind: ProductKind.ANTIFREEZE,
          category: ANTIFREEZE_CATEGORY,
          oilType: null,
        }) as never,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.items[0].code).toBe(ANTIFREEZE_CATEGORY.mxik);
      expect(result.items[0].package_code).toBe(
        ANTIFREEZE_CATEGORY.packageCodeSingle,
      );
      // None of the three motor-oil codes may appear on an antifreeze line.
      const oilCodes = Object.values(OIL_TYPE_FISCAL);
      expect(oilCodes.map((c) => c.mxik)).not.toContain(result.items[0].code);
      expect(oilCodes.map((c) => c.packageCode)).not.toContain(
        result.items[0].package_code,
      );
    });

    it('is NOT diverted onto an oil code by a stray oilType', () => {
      // The defensive "a row carrying an oil type is an oil" clause applies to
      // SPARE_PART only — a kind with its own fiscal taxonomy must never be
      // pulled onto the oil table by a leftover column value.
      const result = buildFiscalItem(
        line({
          kind: ProductKind.ANTIFREEZE,
          category: ANTIFREEZE_CATEGORY,
          oilType: OilType.SYNTHETIC,
        }) as never,
      );
      expect(result.ok && result.items[0].code).toBe(ANTIFREEZE_CATEGORY.mxik);
    });

    it('reports a gap instead of inventing an IKPU when unconfigured', () => {
      // No antifreeze MXIK is invented anywhere in this codebase: an operator
      // enters the real one in the admin console, and until then the checkout
      // refuses rather than fiscalizing under a borrowed code.
      const result = buildFiscalItem(
        line({
          kind: ProductKind.ANTIFREEZE,
          category: {
            mxik: null,
            packageCodeSingle: null,
            packageCodeSet: null,
          },
        }) as never,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.gaps).toEqual([
        'item oi_1: category has no MXIK',
        'item oi_1: category has no package code',
      ]);
    });

    it('leaves a SPARE_PART carrying an oil type on the oil path (unchanged)', () => {
      const result = buildFiscalItem(
        line({
          kind: ProductKind.SPARE_PART,
          oilType: OilType.MINERAL,
        }) as never,
      );
      expect(result.ok && result.items[0].code).toBe(
        OIL_TYPE_FISCAL[OilType.MINERAL].mxik,
      );
    });
  });
});
