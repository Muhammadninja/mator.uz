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

import { Logger } from '@nestjs/common';
import { OilType, PackageForm, Prisma, ProductKind } from '@prisma/client';
import {
  DELIVERY_TITLE,
  FiscalDataIncompleteException,
  PaymeFiscalService,
  SERVICE_FEE_TITLE,
} from './payme-fiscal.service';
import {
  buildFiscalItem,
  orderLineType,
  receiptTotalTiyin,
} from './payme-fiscal.util';
import {
  FISCAL_CODES_UNCONFIRMED,
  OIL_TYPE_FISCAL,
  OIL_TYPE_REQUIRED,
  REPRESENTATIVE_ONLY_MXIK,
} from '../../common/fiscal.util';
import { CATEGORY_FISCAL_DATA } from '../../prisma/seed-data/catalog-reference.seed';
import {
  confirmedCategory,
  createPrismaMock,
  fakeConfig,
  FISCAL_TEST_ENV,
  PrismaMock,
} from '../../../test/utils/harness';

/** Brakes: MXIK plus both package codes (Штука / Комплект), confirmed. */
const BRAKES = confirmedCategory();
/** Filters: one package code, so its sellers are never asked the question. */
const FILTERS = confirmedCategory({
  id: 'filters',
  parentId: 'maintenance-and-fluids',
  mxik: '08421002001000000',
  packageCodeSingle: '1499205',
  packageCodeSet: null,
});
/** A leaf with no codes, the state every unconfigured subcategory is in. */
const bareCategory = (id = 'brake-discs') => ({
  id,
  parentId: 'brake-system',
  mxik: null,
  packageCodeSingle: null,
  packageCodeSet: null,
  fiscalConfirmedCodes: null,
  _count: { children: 0 },
});

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
    const [item] = (await svc.buildOrderDetail('ord_1')).items;
    expect(item.vat_percent).toBe(12);
    expect(item.commission_info).toEqual({ tin: '209876543' });
  });

  it('never sends `units`', async () => {
    stub([orderItem()], [catalogPart()]);
    const [item] = (await svc.buildOrderDetail('ord_1')).items;
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
    const [item] = (await svc.buildOrderDetail('ord_1')).items;
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
    const items = (await svc.buildOrderDetail('ord_1')).items;
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
    stub([orderItem()], [catalogPart({ category: bareCategory() })]);
    await expect(svc.buildOrderDetail('ord_1')).rejects.toBeInstanceOf(
      FiscalDataIncompleteException,
    );
  });

  it('refuses a category whose code nobody has confirmed against Tasnif', async () => {
    stub(
      [orderItem()],
      [catalogPart({ category: { ...BRAKES, fiscalConfirmedCodes: null } })],
    );
    await expect(svc.buildOrderDetail('ord_1')).rejects.toMatchObject({
      gaps: [expect.stringContaining(FISCAL_CODES_UNCONFIRMED)],
    });
  });

  it('refuses an unclassified part: the bucket every new import position starts in', async () => {
    stub(
      [orderItem()],
      [catalogPart({ category: bareCategory('cat_uncategorized') })],
    );
    await expect(svc.buildOrderDetail('ord_1')).rejects.toMatchObject({
      gaps: [expect.stringContaining('not classified')],
    });
  });

  it('gives a client a code to tell this refusal apart from any other 400', async () => {
    stub([orderItem()], [catalogPart({ category: bareCategory() })]);
    await expect(svc.buildOrderDetail('ord_1')).rejects.toMatchObject({
      response: { code: 'FISCAL_DATA_INCOMPLETE' },
    });
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

  it('reads EVERY line of the order: an absent part proves nothing', async () => {
    stub([orderItem()], [catalogPart()]);
    await svc.buildOrderDetail('ord_9');
    expect(prisma.orderItem.findMany.mock.calls[0][0].where).toEqual({
      orderId: 'ord_9',
    });
  });

  it('refuses an order with no lines, and the checkout gate refuses it too', async () => {
    stub([], []);
    await expect(svc.buildOrderDetail('ord_1')).rejects.toBeInstanceOf(
      FiscalDataIncompleteException,
    );
    await expect(svc.assertFiscalizable('ord_1')).rejects.toBeInstanceOf(
      FiscalDataIncompleteException,
    );
  });

  it('refuses an order that does not exist instead of calling it nothing to fiscalize', async () => {
    prisma.order.findUnique.mockResolvedValue(null);
    await expect(svc.buildOrderDetail('nope')).rejects.toBeInstanceOf(
      FiscalDataIncompleteException,
    );
  });
});

// ── What a line states ───────────────────────────────────────────────────────
describe('orderLineType', () => {
  it.each([
    [{ partId: 'p' }, 'PRODUCT'],
    [{ partId: 'p', serviceId: 's' }, 'PRODUCT'],
    [{ offerId: 'o' }, 'SOURCING_OFFER'],
    [{ serviceId: 's' }, 'SERVICE'],
    [{ partId: null, offerId: null, serviceId: null }, 'UNKNOWN'],
    [{}, 'UNKNOWN'],
  ])('%j → %s', (line, type) => {
    expect(orderLineType(line)).toBe(type);
  });
});

describe('order lines that are no catalog part', () => {
  let prisma: PrismaMock;

  beforeEach(() => {
    prisma = createPrismaMock();
  });

  const fiscal = (env: Record<string, string> = {}) =>
    new PaymeFiscalService(prisma, fakeConfig({ ...FISCAL_TEST_ENV, ...env }));

  /** An accepted offer's order line: goods with no part. */
  const offerLine = (over: Record<string, unknown> = {}) => ({
    id: 'oi_1',
    partId: null,
    serviceId: null,
    offerId: 'soff_1',
    offerSellerTgId: '555',
    title: 'Стартер',
    quantity: 1,
    priceUzs: new Prisma.Decimal(150000),
    lineTotalUzs: new Prisma.Decimal(150000),
    ...over,
  });

  const serviceLine = {
    id: 'oi_2',
    partId: null,
    serviceId: 'svc_1',
    offerId: null,
    offerSellerTgId: null,
    title: 'Замена масла',
    quantity: 1,
    priceUzs: new Prisma.Decimal(100000),
    lineTotalUzs: new Prisma.Decimal(100000),
  };

  const stubOrder = (totalUzs: number, deliveryUzs = 0, serviceFeeUzs = 0) =>
    prisma.order.findUnique.mockResolvedValue({
      id: 'ord_1',
      totalUzs: new Prisma.Decimal(totalUzs),
      deliveryUzs: new Prisma.Decimal(deliveryUzs),
      serviceFeeUzs: new Prisma.Decimal(serviceFeeUzs),
      discountUzs: new Prisma.Decimal(0),
    });

  /** The offer's classification, and the storefront behind the seller who made it. */
  const stubOffer = ({
    category = BRAKES as unknown,
    packageForm = null as PackageForm | null,
    dealer = DEALER_A as unknown,
  } = {}) => {
    prisma.sourcingOffer.findMany.mockResolvedValue([
      { id: 'soff_1', packageForm, category },
    ]);
    prisma.seller.findMany.mockResolvedValue([
      { id: 7, tgId: BigInt(555), catalogSellerId: null },
    ]);
    prisma.catalogSeller.findMany.mockResolvedValue(
      dealer ? [{ id: 'seller_7', ...(dealer as object) }] : [],
    );
  };

  it('fiscalizes an offer from its category and its seller’s dealer, with every charge', async () => {
    stubOrder(180000, 25000, 5000);
    prisma.orderItem.findMany.mockResolvedValue([offerLine()]);
    stubOffer({ packageForm: PackageForm.SET });

    const detail = await fiscal().buildOrderDetail('ord_1');

    expect(detail.items.map((i) => i.title)).toEqual([
      'Стартер',
      'Доставка',
      'Сервисный сбор',
    ]);
    expect(detail.items[0]).toEqual({
      title: 'Стартер',
      price: 15_000_000,
      count: 1,
      code: BRAKES.mxik,
      package_code: BRAKES.packageCodeSet,
      vat_percent: 0,
      commission_info: { tin: DEALER_A.tin },
    });
    // Delivery and the fee are not lost, and the receipt is the charge to the tiyin.
    expect(receiptTotalTiyin(detail.items)).toBe(18_000_000);
    expect(prisma.seller.findMany.mock.calls[0][0].where).toEqual({
      tgId: { in: [BigInt(555)] },
    });
  });

  it('takes a dealer linked to a curated storefront through that link', async () => {
    stubOrder(150000);
    prisma.orderItem.findMany.mockResolvedValue([offerLine()]);
    stubOffer();
    prisma.seller.findMany.mockResolvedValue([
      { id: 7, tgId: BigInt(555), catalogSellerId: 'drivers-village' },
    ]);
    prisma.catalogSeller.findMany.mockResolvedValue([
      { id: 'drivers-village', ...DEALER_B },
    ]);

    const [item] = (await fiscal().buildOrderDetail('ord_1')).items;

    expect(item.commission_info).toEqual({ tin: DEALER_B.tin });
    expect(item.vat_percent).toBe(12);
  });

  it('an offer nobody has classified is refused, not given a made-up code', async () => {
    stubOrder(150000);
    prisma.orderItem.findMany.mockResolvedValue([offerLine()]);
    stubOffer({ category: null });

    await expect(fiscal().buildOrderDetail('ord_1')).rejects.toMatchObject({
      gaps: [
        'item oi_1 (sourcing offer soff_1): category fiscal data is unavailable',
      ],
    });
  });

  it('an offer whose category is not confirmed is refused', async () => {
    stubOrder(150000);
    prisma.orderItem.findMany.mockResolvedValue([offerLine()]);
    stubOffer({ category: { ...BRAKES, fiscalConfirmedCodes: null } });

    await expect(fiscal().buildOrderDetail('ord_1')).rejects.toMatchObject({
      gaps: [expect.stringContaining(FISCAL_CODES_UNCONFIRMED)],
    });
  });

  it.each([
    ['the seller has no storefront yet', {}],
    ['the seller id is not a Telegram id', { offerSellerTgId: 'abc' }],
    ['the line names no seller at all', { offerSellerTgId: null }],
  ])('refuses when %s: no tax id is invented', async (_, line) => {
    stubOrder(150000);
    prisma.orderItem.findMany.mockResolvedValue([offerLine(line)]);
    stubOffer({ dealer: null });

    await expect(fiscal().buildOrderDetail('ord_1')).rejects.toMatchObject({
      gaps: [expect.stringContaining('dealer is unavailable')],
    });
  });

  it('refuses a dealer whose tax data is not entered', async () => {
    stubOrder(150000);
    prisma.orderItem.findMany.mockResolvedValue([offerLine()]);
    stubOffer({ dealer: { tin: null, vatPercent: null } });

    await expect(fiscal().buildOrderDetail('ord_1')).rejects.toMatchObject({
      gaps: [
        expect.stringContaining('dealer has no TIN'),
        expect.stringContaining('dealer has no VAT percentage'),
      ],
    });
  });

  it('fiscalizes a part and an offer in one order, each with its own dealer, in order', async () => {
    stubOrder(300000);
    prisma.orderItem.findMany.mockResolvedValue([
      offerLine({ id: 'oi_a' }),
      {
        ...orderItem({ id: 'oi_b', title: 'Колодки' }),
        lineTotalUzs: new Prisma.Decimal(150000),
      },
    ]);
    stubOffer({ dealer: DEALER_B });
    prisma.catalogPart.findMany.mockResolvedValue([catalogPart()]);

    const { items } = (await fiscal().buildOrderDetail('ord_1'))!;

    expect(items.map((i) => [i.title, i.commission_info?.tin])).toEqual([
      ['Стартер', DEALER_B.tin],
      ['Колодки', DEALER_A.tin],
    ]);
    expect(receiptTotalTiyin(items)).toBe(30_000_000);
  });

  it('a line from before the link existed states nothing, and is refused', async () => {
    // An offer line written before offer_id: no part, offer or service. It used to
    // read as "services only" and be paid for with no receipt at all.
    stubOrder(180000, 25000, 5000);
    prisma.orderItem.findMany.mockResolvedValue([
      offerLine({ offerId: null, offerSellerTgId: null }),
    ]);

    await expect(fiscal().buildOrderDetail('ord_1')).rejects.toMatchObject({
      gaps: expect.arrayContaining([
        'item oi_1: the line states no part, offer or service',
      ]),
    });
  });

  /** A service an operator has classified, and its provider's tax data. */
  const SERVICE_CATEGORY = confirmedCategory({
    id: 'oil-change-service',
    parentId: 'services',
    mxik: '10101010101010101',
    packageCodeSingle: '1000002',
    packageCodeSet: null,
  });
  const PROVIDER = { tin: '301234567', vatPercent: new Prisma.Decimal(12) };
  const stubService = (over: Record<string, unknown> = {}) =>
    prisma.providerServiceOffering.findMany.mockResolvedValue([
      { id: 'svc_1', category: SERVICE_CATEGORY, provider: PROVIDER, ...over },
    ]);
  const ALLOWED = { PAYME_ALLOW_SERVICE_ONLY_ORDERS: 'true' };

  describe('an order made up of services only', () => {
    beforeEach(() => {
      stubOrder(130000, 25000, 5000);
      prisma.orderItem.findMany.mockResolvedValue([serviceLine]);
      stubService();
    });

    it.each([
      ['absent', {}],
      ['false', { PAYME_ALLOW_SERVICE_ONLY_ORDERS: 'false' }],
      ['blank', { PAYME_ALLOW_SERVICE_ONLY_ORDERS: '' }],
      ['TRUE, which is not true', { PAYME_ALLOW_SERVICE_ONLY_ORDERS: 'TRUE' }],
      ['1, which is not true', { PAYME_ALLOW_SERVICE_ONLY_ORDERS: '1' }],
    ])('is refused with the variable %s, however complete it is', async (_, env) => {
      await expect(fiscal(env).buildOrderDetail('ord_1')).rejects.toMatchObject({
        gaps: [expect.stringContaining('PAYME_ALLOW_SERVICE_ONLY_ORDERS')],
      });
    });

    it('with it true, fully classified lines get a full receipt, never none', async () => {
      const detail = await fiscal(ALLOWED).buildOrderDetail('ord_1');

      expect(detail.items[0]).toEqual({
        title: 'Замена масла',
        price: 10_000_000,
        count: 1,
        code: '10101010101010101',
        package_code: '1000002',
        vat_percent: 12,
        commission_info: { tin: '301234567' },
      });
      // Delivery and the service fee are on it too, and it adds up to the charge.
      expect(detail.items.map((i) => i.title)).toEqual([
        'Замена масла',
        DELIVERY_TITLE,
        SERVICE_FEE_TITLE,
      ]);
      expect(detail.items.reduce((n, i) => n + i.price * i.count, 0)).toBe(
        13_000_000,
      );
    });

    it.each<[string, Record<string, unknown>, string]>([
      ['no category', { category: null }, 'category fiscal data is unavailable'],
      [
        'a category nobody confirmed',
        { category: { ...SERVICE_CATEGORY, fiscalConfirmedCodes: null } },
        FISCAL_CODES_UNCONFIRMED,
      ],
      [
        'a category with no MXIK',
        {
          category: {
            ...SERVICE_CATEGORY,
            mxik: null,
            packageCodeSingle: null,
            fiscalConfirmedCodes: null,
          },
        },
        'category has no MXIK',
      ],
      [
        'a category whose package code was changed',
        { category: { ...SERVICE_CATEGORY, packageCodeSingle: '1000003' } },
        FISCAL_CODES_UNCONFIRMED,
      ],
      [
        'a parent category',
        { category: { ...SERVICE_CATEGORY, _count: { children: 2 } } },
        'has subcategories',
      ],
      [
        'a provider with no tax id',
        { provider: { ...PROVIDER, tin: null } },
        'dealer has no TIN',
      ],
      [
        'a provider with no VAT rate',
        { provider: { ...PROVIDER, vatPercent: null } },
        'dealer has no VAT percentage',
      ],
    ])('with it true, %s is still refused', async (_, over, gap) => {
      stubService(over);
      await expect(
        fiscal(ALLOWED).buildOrderDetail('ord_1'),
      ).rejects.toMatchObject({
        gaps: expect.arrayContaining([expect.stringContaining(gap)]),
      });
    });

    it('with it true, a service that no longer exists is still refused', async () => {
      prisma.providerServiceOffering.findMany.mockResolvedValue([]);
      await expect(
        fiscal(ALLOWED).buildOrderDetail('ord_1'),
      ).rejects.toMatchObject({
        gaps: expect.arrayContaining([
          expect.stringContaining('category fiscal data is unavailable'),
          expect.stringContaining('dealer is unavailable'),
        ]),
      });
    });

    it('with it true, services have nothing to deliver: no cost is needed for them', async () => {
      stubOrder(100000);
      prisma.order.findUnique.mockResolvedValue({
        id: 'ord_1',
        deliveryMethod: 'COURIER',
        totalUzs: new Prisma.Decimal(100000),
        deliveryUzs: new Prisma.Decimal(0),
        serviceFeeUzs: new Prisma.Decimal(0),
        discountUzs: new Prisma.Decimal(0),
      });

      const detail = await fiscal(ALLOWED).buildOrderDetail('ord_1');

      expect(detail.items.map((i) => i.title)).toEqual(['Замена масла']);
    });

    it('with it true, a charge with no codes is still refused', async () => {
      await expect(
        new PaymeFiscalService(
          prisma,
          fakeConfig({ ...ALLOWED }),
        ).buildOrderDetail('ord_1'),
      ).rejects.toMatchObject({
        gaps: expect.arrayContaining([
          expect.stringContaining('service fee'),
        ]),
      });
    });

    it('with it true, a receipt that does not add up is still refused', async () => {
      stubOrder(999999, 25000, 5000);
      await expect(
        fiscal(ALLOWED).buildOrderDetail('ord_1'),
      ).rejects.toMatchObject({
        gaps: [expect.stringContaining('does not match the charged')],
      });
    });
  });

  it.each([
    ['absent', {}],
    ['false', { PAYME_ALLOW_SERVICE_ONLY_ORDERS: 'false' }],
    ['true', ALLOWED],
  ])('a line stating nothing is refused with the variable %s', async (_, env) => {
    stubOrder(100000);
    prisma.orderItem.findMany.mockResolvedValue([
      { ...serviceLine, serviceId: null },
    ]);
    await expect(fiscal(env).buildOrderDetail('ord_1')).rejects.toMatchObject({
      gaps: expect.arrayContaining([
        'item oi_2: the line states no part, offer or service',
      ]),
    });
  });

  describe('a service line beside goods', () => {
    beforeEach(() => {
      stubOrder(250000);
      prisma.orderItem.findMany.mockResolvedValue([
        serviceLine,
        {
          ...orderItem({ id: 'oi_1' }),
          lineTotalUzs: new Prisma.Decimal(150000),
        },
      ]);
      prisma.catalogPart.findMany.mockResolvedValue([catalogPart()]);
    });

    it.each([
      ['absent', {}],
      ['true', ALLOWED],
    ])('classified, it is on the receipt with the variable %s', async (_, env) => {
      stubService();
      const detail = await fiscal(env).buildOrderDetail('ord_1');
      expect(detail.items.map((i) => i.code)).toEqual([
        '10101010101010101',
        BRAKES.mxik,
      ]);
    });

    it.each([
      ['absent', {}],
      ['true', ALLOWED],
    ])('unclassified, it is refused with the variable %s', async (_, env) => {
      stubService({ category: null });
      await expect(fiscal(env).buildOrderDetail('ord_1')).rejects.toMatchObject({
        gaps: expect.arrayContaining([
          'item oi_2 (service svc_1): category fiscal data is unavailable',
        ]),
      });
    });
  });
});

// The rule a manually distributed catalog depends on: a product takes the MXIK of the
// exact category it is filed on, and the node above it has no say.
describe('a product and the category above it', () => {
  let prisma: PrismaMock;
  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.order.findUnique.mockResolvedValue({
      id: 'ord_1',
      totalUzs: new Prisma.Decimal(150000),
      deliveryUzs: new Prisma.Decimal(0),
      serviceFeeUzs: new Prisma.Decimal(0),
      discountUzs: new Prisma.Decimal(0),
    });
    prisma.orderItem.findMany.mockResolvedValue([orderItem()]);
  });
  const receipt = () =>
    new PaymeFiscalService(prisma, fakeConfig({})).buildOrderDetail('ord_1');
  const SUB_MXIK = '09999999999999901';

  it('the query reads the category itself: a parent is never even fetched', async () => {
    prisma.catalogPart.findMany.mockResolvedValue([
      catalogPart({
        category: confirmedCategory({
          id: 'sub',
          parentId: 'lighting',
          mxik: SUB_MXIK,
          packageCodeSet: null,
        }),
      }),
    ]);
    await receipt();
    const { select } = prisma.catalogPart.findMany.mock.calls[0][0];
    expect(select.category.select).not.toHaveProperty('parent');
  });

  describe.each(Object.entries(REPRESENTATIVE_ONLY_MXIK))(
    'under %s',
    (parentId, parentMxik) => {
      it('a product on a subcategory carries the subcategory’s MXIK', async () => {
        prisma.catalogPart.findMany.mockResolvedValue([
          catalogPart({
            category: confirmedCategory({
              id: `${parentId}-sub`,
              parentId,
              mxik: SUB_MXIK,
              packageCodeSingle: '1000009',
              packageCodeSet: null,
            }),
          }),
        ]);

        const [item] = (await receipt()).items;

        expect(item.code).toBe(SUB_MXIK);
        expect(item.code).not.toBe(parentMxik);
        expect(item.package_code).toBe('1000009');
      });

      it('a subcategory with no code of its own is refused, not given the parent’s', async () => {
        prisma.catalogPart.findMany.mockResolvedValue([
          catalogPart({ category: bareCategory(`${parentId}-sub`) }),
        ]);
        await expect(receipt()).rejects.toMatchObject({
          gaps: expect.arrayContaining([
            expect.stringContaining('category has no MXIK'),
          ]),
        });
      });

      it('a product left on the node itself is refused', async () => {
        prisma.catalogPart.findMany.mockResolvedValue([
          catalogPart({
            category: {
              ...bareCategory(parentId),
              mxik: parentMxik,
              packageCodeSingle: '1350563',
              // Even a confirmation already stored against it does not count.
              fiscalConfirmedCodes: `${parentMxik}:1350563:`,
            },
          }),
        ]);
        await expect(receipt()).rejects.toMatchObject({
          gaps: expect.arrayContaining([
            expect.stringContaining('describes one product of what it holds'),
          ]),
        });
      });
    },
  );
});

describe('motor-oil fiscal resolution', () => {
  let prisma: PrismaMock;
  let svc: PaymeFiscalService;

  beforeEach(() => {
    prisma = createPrismaMock();
    svc = new PaymeFiscalService(prisma, fakeConfig({}));
  });

  const COMPOSITION_OF: Record<OilType, string> = {
    [OilType.SYNTHETIC]: 'synthetic-motor-oil',
    [OilType.SEMI_SYNTHETIC]: 'semi-synthetic-motor-oil',
    [OilType.MINERAL]: 'mineral-motor-oil',
  };

  /** A composition category: confirmed, and carrying NO codes of its own. */
  const composition = (type: OilType, over: Record<string, unknown> = {}) =>
    confirmedCategory({
      id: COMPOSITION_OF[type],
      parentId: 'motor-oil',
      mxik: null,
      packageCodeSingle: null,
      packageCodeSet: null,
      ...over,
    });

  /** An oil listing on its composition (the synthetic one when it states no type). */
  const oilPart = (oilType: OilType | null) => ({
    id: 'part_1',
    packageForm: null,
    kind: ProductKind.MOTOR_OIL,
    oilType,
    category: composition(oilType ?? OilType.SYNTHETIC),
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
      const [item] = (await svc.buildOrderDetail('ord_1')).items;
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
    const [item] = (await svc.buildOrderDetail('ord_1')).items;
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

  it('a code an operator entered on a composition is the one used, not the table’s', async () => {
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
      {
        ...oilPart(OilType.MINERAL),
        category: composition(OilType.MINERAL, {
          mxik: '02710005999000000',
          packageCodeSingle: '1282999',
        }),
      },
    ]);

    const [item] = (await svc.buildOrderDetail('ord_1')).items;
    expect(item.code).toBe('02710005999000000');
    expect(item.package_code).toBe('1282999');
  });

  it('an oil listing on a brake category is refused, oil type or not', async () => {
    prisma.order.findUnique.mockResolvedValue({
      id: 'ord_1',
      totalUzs: new Prisma.Decimal(150000),
      deliveryUzs: new Prisma.Decimal(0),
      serviceFeeUzs: new Prisma.Decimal(0),
      discountUzs: new Prisma.Decimal(0),
    });
    prisma.orderItem.findMany.mockResolvedValue([orderItem()]);
    prisma.catalogPart.findMany.mockResolvedValue([
      { ...oilPart(OilType.MINERAL), category: BRAKES },
    ]);

    await expect(svc.buildOrderDetail('ord_1')).rejects.toBeInstanceOf(
      FiscalDataIncompleteException,
    );
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

    const [item] = (await svc.buildOrderDetail('ord_1')).items;
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
        ...FISCAL_TEST_ENV,
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
    deliveryMethod?: string;
  }) => {
    const discount = charges.discountUzs ?? 0;
    prisma.order.findUnique.mockResolvedValue({
      id: 'ord_1',
      deliveryMethod:
        charges.deliveryMethod ??
        (charges.deliveryUzs > 0 ? 'COURIER' : 'PICKUP'),
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

  it('an order with goods and delivery has two separate lines', async () => {
    stubOrder({ deliveryUzs: 25000, serviceFeeUzs: 0 });
    const detail = await withCodes().buildOrderDetail('ord_1');

    expect(detail.items).toHaveLength(2);
    expect(detail.items[0].title).toBe('Колодки');
    expect(detail.items[1]).toEqual({
      title: 'Доставка',
      price: 2_500_000,
      count: 1,
      code: '10112006002000000',
      package_code: '1542432',
      vat_percent: 0,
    });
  });

  it.each([
    [25000, 2_500_000],
    [18000.5, 1_800_050],
    [1, 100],
  ])(
    'the delivery line is the order’s own charge of %d, once',
    async (deliveryUzs, tiyin) => {
      stubOrder({ deliveryUzs, serviceFeeUzs: 0 });
      const detail = await withCodes().buildOrderDetail('ord_1');

      expect(detail.items[1]).toMatchObject({ price: tiyin, count: 1 });
      expect(receiptTotalTiyin(detail.items)).toBe(15_000_000 + tiyin);
    },
  );

  it('no environment can change delivery’s codes, the old ones included', async () => {
    stubOrder({ deliveryUzs: 25000, serviceFeeUzs: 0 });
    const detail = await withCodes({
      DELIVERY_MXIK: '05320001001000000',
      DELIVERY_PACKAGE_CODE: '1000000',
    }).buildOrderDetail('ord_1');

    expect(detail.items[1]).toMatchObject({
      code: '10112006002000000',
      package_code: '1542432',
    });
  });

  it('delivery’s code asks for no category and no confirmation', async () => {
    stubOrder({ deliveryUzs: 25000, serviceFeeUzs: 0 });
    await withCodes().buildOrderDetail('ord_1');
    expect(prisma.partCategory.findUnique).not.toHaveBeenCalled();
    expect(prisma.partCategory.findMany).not.toHaveBeenCalled();
  });

  it('the goods keep their own MXIK and their own confirmation', async () => {
    stubOrder({ deliveryUzs: 25000, serviceFeeUzs: 0 });
    prisma.catalogPart.findMany.mockResolvedValue([
      {
        id: 'part_1',
        packageForm: null,
        kind: ProductKind.SPARE_PART,
        oilType: null,
        category: { ...BRAKES, fiscalConfirmedCodes: null },
        seller: DEALER_A,
      },
    ]);
    await expect(withCodes().buildOrderDetail('ord_1')).rejects.toMatchObject({
      gaps: [expect.stringContaining(FISCAL_CODES_UNCONFIRMED)],
    });
  });

  describe('a line already coded as delivery', () => {
    const DELIVERY_SERVICE = confirmedCategory({
      id: 'courier-service',
      parentId: 'services',
      mxik: '10112006002000000',
      packageCodeSingle: '1542432',
      packageCodeSet: null,
    });
    const stubDeliveryLine = (totalUzs: number) => {
      stubOrder({ deliveryUzs: 25000, serviceFeeUzs: 0, totalUzs });
      prisma.orderItem.findMany.mockResolvedValue([
        product,
        {
          id: 'oi_2',
          partId: null,
          serviceId: 'svc_1',
          title: 'Доставка',
          quantity: 1,
          priceUzs: new Prisma.Decimal(25000),
          lineTotalUzs: new Prisma.Decimal(25000),
        },
      ]);
      prisma.providerServiceOffering.findMany.mockResolvedValue([
        {
          id: 'svc_1',
          category: DELIVERY_SERVICE,
          provider: { tin: '301234567', vatPercent: new Prisma.Decimal(0) },
        },
      ]);
    };

    it('is the charge: delivery is not added a second time', async () => {
      stubDeliveryLine(175000);
      const detail = await withCodes().buildOrderDetail('ord_1');

      expect(
        detail.items.filter((item) => item.code === '10112006002000000'),
      ).toHaveLength(1);
      expect(receiptTotalTiyin(detail.items)).toBe(17_500_000);
    });

    it('an order charging for it on top of that is refused', async () => {
      stubDeliveryLine(200000);
      await expect(withCodes().buildOrderDetail('ord_1')).rejects.toMatchObject({
        gaps: [expect.stringContaining('does not match the charged')],
      });
    });
  });

  describe('the delivery cost stored on the order', () => {
    const REFUSAL = { code: 'DELIVERY_COST_UNAVAILABLE' };

    it.each<[string, unknown]>([
      ['absent', null],
      ['not a number', Number.NaN],
      ['negative', -1000],
    ])('%s: refused, with nothing put in its place', async (_, deliveryUzs) => {
      stubOrder({ deliveryUzs: 0, serviceFeeUzs: 0 });
      prisma.order.findUnique.mockResolvedValue({
        id: 'ord_1',
        deliveryMethod: 'COURIER',
        totalUzs: new Prisma.Decimal(150000),
        deliveryUzs,
        serviceFeeUzs: new Prisma.Decimal(0),
        discountUzs: new Prisma.Decimal(0),
      });

      await expect(withCodes().buildOrderDetail('ord_1')).rejects.toMatchObject({
        gaps: ['the delivery cost stored on the order is invalid'],
        response: REFUSAL,
      });
    });

    it('goods by courier with no cost: refused, however it came to be stored', async () => {
      stubOrder({ deliveryUzs: 0, serviceFeeUzs: 0, deliveryMethod: 'COURIER' });

      await expect(withCodes().buildOrderDetail('ord_1')).rejects.toMatchObject({
        gaps: ['the order is for courier delivery and holds no delivery cost'],
        response: REFUSAL,
      });
      await expect(
        withCodes().assertFiscalizable('ord_1'),
      ).rejects.toBeInstanceOf(FiscalDataIncompleteException);
    });

    it('pickup with a cost contradicts itself: refused', async () => {
      stubOrder({
        deliveryUzs: 25000,
        serviceFeeUzs: 0,
        deliveryMethod: 'PICKUP',
      });

      await expect(withCodes().buildOrderDetail('ord_1')).rejects.toMatchObject({
        gaps: ['the order is for pickup and holds a delivery cost'],
        response: REFUSAL,
      });
    });

    it('pickup with none needs no delivery line, and no delivery VAT rate either', async () => {
      stubOrder({ deliveryUzs: 0, serviceFeeUzs: 0, deliveryMethod: 'PICKUP' });

      const detail = await new PaymeFiscalService(
        prisma,
        fakeConfig({}),
      ).buildOrderDetail('ord_1');

      expect(detail.items.map((i) => i.title)).toEqual(['Колодки']);
    });

    it('what is stored is what is on the line, whatever the environment still says', async () => {
      stubOrder({ deliveryUzs: 37500, serviceFeeUzs: 0 });

      const detail = await withCodes({
        DELIVERY_COURIER_UZS: '25000',
        SERVICE_FEE_UZS: '5000',
      }).buildOrderDetail('ord_1');

      expect(detail.items).toHaveLength(2);
      expect(detail.items[1]).toMatchObject({ price: 3_750_000, count: 1 });
    });

    it('every read of an order gives the same line: nothing fetches a newer cost', async () => {
      stubOrder({ deliveryUzs: 37500, serviceFeeUzs: 0 });
      const service = withCodes();

      const atCheck = await service.buildOrderDetail('ord_1');
      const atCreate = await service.buildOrderDetail('ord_1');

      expect(atCreate).toEqual(atCheck);
      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('delivery’s VAT rate', () => {
    it.each<[string, Record<string, string | undefined>]>([
      ['absent', { DELIVERY_VAT_PERCENT: undefined }],
      ['blank', { DELIVERY_VAT_PERCENT: '' }],
      ['not a number', { DELIVERY_VAT_PERCENT: 'abc' }],
      ['written with a sign', { DELIVERY_VAT_PERCENT: '12%' }],
      ['out of range', { DELIVERY_VAT_PERCENT: '101' }],
    ])('%s: refused, naming the setting, rather than sent as 0', async (_, env) => {
      stubOrder({ deliveryUzs: 25000, serviceFeeUzs: 0 });

      await expect(
        withCodes(env as Record<string, string>).buildOrderDetail('ord_1'),
      ).rejects.toMatchObject({
        gaps: [
          'delivery fee (set DELIVERY_VAT_PERCENT): no valid VAT percentage is configured',
        ],
      });
    });

    it.each([
      ['0', 0],
      ['7', 7],
    ])('stated as %s, the line carries exactly that', async (value, expected) => {
      stubOrder({ deliveryUzs: 25000, serviceFeeUzs: 0 });

      const detail = await withCodes({
        DELIVERY_VAT_PERCENT: value,
      }).buildOrderDetail('ord_1');

      expect(detail.items[1].vat_percent).toBe(expected);
    });

    it('its absence is said at boot, before a customer is refused', () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      new PaymeFiscalService(prisma, fakeConfig({})).onModuleInit();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('DELIVERY_VAT_PERCENT'),
      );

      warn.mockClear();
      withCodes().onModuleInit();
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  it('delivery’s name goes in the required title field, exactly as approved', async () => {
    stubOrder({ deliveryUzs: 25000, serviceFeeUzs: 0 });
    const detail = await withCodes().buildOrderDetail('ord_1');
    expect(DELIVERY_TITLE).toBe('Доставка');
    expect(detail.items[1].title).toBe('Доставка');
  });

  describe('delivery and PAYME_ALLOW_SERVICE_ONLY_ORDERS', () => {
    it.each([
      ['absent', {}],
      ['false', { PAYME_ALLOW_SERVICE_ONLY_ORDERS: 'false' }],
    ])(
      'goods with delivery are not service-only, with the variable %s',
      async (_, env) => {
        stubOrder({ deliveryUzs: 25000, serviceFeeUzs: 0 });
        const detail = await withCodes(env).buildOrderDetail('ord_1');
        expect(detail.items).toHaveLength(2);
      },
    );

    it('a delivery charge does not make an order of services payable', async () => {
      stubOrder({ deliveryUzs: 25000, serviceFeeUzs: 0, totalUzs: 125000 });
      prisma.orderItem.findMany.mockResolvedValue([
        {
          id: 'oi_2',
          partId: null,
          serviceId: 'svc_1',
          title: 'Замена масла',
          quantity: 1,
          priceUzs: new Prisma.Decimal(100000),
          lineTotalUzs: new Prisma.Decimal(100000),
        },
      ]);
      await expect(withCodes().buildOrderDetail('ord_1')).rejects.toMatchObject({
        gaps: [expect.stringContaining('PAYME_ALLOW_SERVICE_ONLY_ORDERS')],
      });
    });
  });

  it('adds NO delivery line when there is no delivery fee (pickup)', async () => {
    stubOrder({ deliveryUzs: 0, serviceFeeUzs: 0 });
    const detail = await withCodes().buildOrderDetail('ord_1');
    expect(detail.items).toHaveLength(1);
    expect(detail.items.map((i) => i.title)).toEqual(['Колодки']);
  });

  it('takes delivery’s VAT rate from configuration', async () => {
    stubOrder({ deliveryUzs: 25000, serviceFeeUzs: 0 });
    const detail = await withCodes({
      DELIVERY_VAT_PERCENT: '12',
    }).buildOrderDetail('ord_1');

    expect(detail.items[1]).toMatchObject({ vat_percent: 12 });
  });

  it('attributes platform lines to the MARKETPLACE tin when configured', async () => {
    stubOrder({ deliveryUzs: 25000, serviceFeeUzs: 0 });
    const detail = await withCodes({
      MARKETPLACE_TIN: '123456789',
    }).buildOrderDetail('ord_1');

    expect(detail.items[1].commission_info).toEqual({ tin: '123456789' });
    // The product line still settles to its own DEALER.
    expect(detail.items[0].commission_info).toEqual({ tin: '301234567' });
  });

  it('omits commission_info on a platform line when no marketplace tin is set', async () => {
    stubOrder({ deliveryUzs: 25000, serviceFeeUzs: 0 });
    const detail = await withCodes().buildOrderDetail('ord_1');
    expect(detail.items[1]).not.toHaveProperty('commission_info');
  });

  it('adds a service-fee line when the order carries one', async () => {
    stubOrder({ deliveryUzs: 25000, serviceFeeUzs: 5000 });
    const detail = await withCodes().buildOrderDetail('ord_1');

    expect(detail.items.map((i) => i.title)).toEqual([
      'Колодки',
      'Доставка',
      'Сервисный сбор',
    ]);
    expect(detail.items[2]).toMatchObject({
      price: 500_000,
      count: 1,
      code: '10307001001000000',
      package_code: '1000001',
    });
  });

  it('refuses a service fee whose codes are not configured, naming the keys', async () => {
    stubOrder({ deliveryUzs: 25000, serviceFeeUzs: 5000 });
    const unconfigured = new PaymeFiscalService(
      prisma,
      fakeConfig({ DELIVERY_VAT_PERCENT: '0' }),
    );

    // Every missing part is reported, each naming the env key an operator has to
    // set — one round trip, not several.
    await expect(unconfigured.buildOrderDetail('ord_1')).rejects.toMatchObject({
      gaps: [
        expect.stringContaining('SERVICE_FEE_MXIK'),
        expect.stringContaining('SERVICE_FEE_PACKAGE_CODE'),
        expect.stringContaining('SERVICE_FEE_VAT_PERCENT'),
      ],
    });
  });

  // ── the sum Payme itself checks ────────────────────────────────────────────
  it('makes products + delivery + fee add up to the charged amount', async () => {
    stubOrder({ deliveryUzs: 25000, serviceFeeUzs: 5000 });
    const detail = await withCodes().buildOrderDetail('ord_1');

    const receipt = receiptTotalTiyin(detail.items);
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
    expect(receiptTotalTiyin(detail.items)).toBe(47_500_000);
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
    expect(receiptTotalTiyin(detail.items)).toBe(16_000_000);
  });

  it.each([
    ['absent', {}],
    ['false', { PAYME_ALLOW_SERVICE_ONLY_ORDERS: 'false' }],
    ['true', { PAYME_ALLOW_SERVICE_ONLY_ORDERS: 'true' }],
  ])(
    'never sends fees alone: no lines is refused with the variable %s',
    async (_, env) => {
      // A receipt containing only a delivery fee would be neither complete nor
      // reconcilable, and having no lines says nothing about what was sold. The
      // variable is about orders of services, and an order of nothing is not one.
      prisma.order.findUnique.mockResolvedValue({
        id: 'ord_1',
        totalUzs: new Prisma.Decimal(25000),
        deliveryUzs: new Prisma.Decimal(25000),
        serviceFeeUzs: new Prisma.Decimal(0),
        discountUzs: new Prisma.Decimal(0),
      });
      prisma.orderItem.findMany.mockResolvedValue([]);

      await expect(withCodes(env).buildOrderDetail('ord_1')).rejects.toMatchObject(
        { gaps: ['the order has no lines'] },
      );
    },
  );
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
        category: bareCategory(),
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
    const ANTIFREEZE_CATEGORY = confirmedCategory({
      id: 'antifreeze',
      parentId: 'maintenance-and-fluids',
      mxik: CATEGORY_FISCAL_DATA.antifreeze.mxik,
      packageCodeSingle: CATEGORY_FISCAL_DATA.antifreeze.packageCodeSingle,
      packageCodeSet: null,
    });

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
      // A kind with its own fiscal taxonomy must never be pulled onto the oil table
      // by a leftover column value.
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
          category: bareCategory('antifreeze'),
        }) as never,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.gaps).toEqual([
        'item oi_1: category has no MXIK',
        'item oi_1: category has no package code',
      ]);
    });

    it('a SPARE_PART carrying an oil type stays on its category: a column is no proof', () => {
      const result = buildFiscalItem(
        line({
          kind: ProductKind.SPARE_PART,
          oilType: OilType.MINERAL,
        }) as never,
      );
      expect(result.ok && result.items[0].code).toBe(BRAKES.mxik);
    });
  });
});
