/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Payme Check against a catalog an operator distributed by hand: every subcategory
 * with its own MXIK, and the four broad nodes above or beside them still holding the
 * codes they were seeded with.
 *
 * A real request goes through the real route, PaymeService, the receipt builder, the
 * resolver and the admin category console, so a confirmation made through the API has
 * to be what the receipt then reads. Prisma is mocked and keeps its rows in memory.
 *
 * What Check hands Payme is the receipt frozen on the invoice, so `check` does what a
 * customer does first: it starts the payment. That is where a refusal now happens, and
 * with no invoice Check refuses too. `checkAgain` leaves the invoice as it is.
 *
 * That also bounds what this shows. It says nothing about PostgreSQL: no query here
 * reached a database, and no race can happen in a single process. It is not evidence
 * that production is ready, nor that any real code here is correct: every MXIK below
 * is fictional, except the seeded candidates, which nobody has confirmed.
 */
import {
  ExecutionContext,
  HttpException,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { OilType, ProductKind } from '@prisma/client';
import request from 'supertest';
import { AdminCategoriesController } from '../../src/admin/categories/admin-categories.controller';
import { AdminCategoriesService } from '../../src/admin/categories/admin-categories.service';
import { AdminCategoryTransferService } from '../../src/admin/categories/admin-category-transfer.service';
import { AdminAuditService } from '../../src/admin/auth/admin-audit.service';
import { AdminJwtGuard } from '../../src/admin/auth/guards/admin-jwt.guard';
import { PartCategoryService } from '../../src/catalog/categories/part-category.service';
import {
  confirmableFiscalCodes,
  OIL_TYPE_FISCAL,
} from '../../src/common/fiscal.util';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter';
import { PaymentsService } from '../../src/orders/payments.service';
import { ClickService } from '../../src/orders/webhooks/click.service';
import { PaymeFiscalReceiptService } from '../../src/orders/webhooks/payme-fiscal-receipt.service';
import { PaymeFiscalService } from '../../src/orders/webhooks/payme-fiscal.service';
import {
  PAYME_WEBHOOK_PATH,
  paymeRawBodyMiddleware,
} from '../../src/orders/webhooks/payme-raw-body.middleware';
import { PaymeService } from '../../src/orders/webhooks/payme.service';
import { PaymentWebhookController } from '../../src/orders/webhooks/payment-webhook.controller';
import { SettlementService } from '../../src/orders/webhooks/settlement.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { CATEGORY_FISCAL_DATA } from '../../src/prisma/seed-data/catalog-reference.seed';
import {
  buildOrder,
  createPrismaMock,
  fakeAudit,
  PrismaMock,
} from '../utils/harness';

// Set here, read by nothing else: no real key, token or configuration is involved.
const FAKE_KEY = 'smoke-test-merchant-key-not-a-secret';
const AUTH = 'Basic ' + Buffer.from(`Paycom:${FAKE_KEY}`).toString('base64');
const BASE_ENV = {
  PAYME_MERCHANT_KEY: FAKE_KEY,
  PAYME_MERCHANT_ID: 'smoke-merchant',
  PAYME_ACCOUNT_FIELD: 'order_id',
  SERVICE_FEE_MXIK: '09900000000000002',
  SERVICE_FEE_PACKAGE_CODE: '1000002',
  SERVICE_FEE_VAT_PERCENT: '7',
  // A test value: no rate for delivery has been decided, and 7 is not a real one.
  DELIVERY_VAT_PERCENT: '7',
};
const FLAG = 'PAYME_ALLOW_SERVICE_ONLY_ORDERS';

const DELIVERY_MXIK = '10112006002000000';
const DELIVERY_UNIT_CODE = '1542432';

const DEALER = { status: 'ACTIVE', tin: '301234567', vatPercent: 12 };
const REFUSED = -31008;

/** Fictional codes: one per subcategory, none of them any node's seeded code. */
const SUB_MXIK = '09911111111111111';
const SUB_PACKAGE = '1000011';

describe('Payme Check for a hand-distributed catalog (smoke, Prisma mocked)', () => {
  let app: INestApplication;
  let prisma: PrismaMock;
  let env: Record<string, string | undefined>;
  let admin: { role: string };
  let categories: Map<string, any>;
  let parts: Map<string, any>;
  let offerings: Map<string, any>;
  let offers: Map<string, any>;
  let order: any;
  let lines: any[];
  let invoices: any[];
  let receipts: Map<string, any>;
  let payments: PaymentsService;

  const counted = (row: any) => ({
    ...row,
    _count: {
      parts: [...parts.values()].filter((p) => p.categoryId === row.id).length,
      products: 0,
      productsVehicle: 0,
      drafts: 0,
      draftsVehicle: 0,
      children: [...categories.values()].filter(
        (c) => c.parentId === row.id && c.isActive,
      ).length,
    },
  });
  const categoryRow = (id: string | null) => {
    const row = id ? categories.get(id) : null;
    return row ? counted(row) : null;
  };

  beforeEach(async () => {
    categories = new Map();
    parts = new Map();
    offerings = new Map();
    offers = new Map();
    lines = [];
    invoices = [];
    receipts = new Map();
    order = null;
    env = { ...BASE_ENV };
    admin = { role: 'SUPER_ADMIN' };
    prisma = createPrismaMock();

    prisma.partCategory.findUnique.mockImplementation(({ where }: any) =>
      Promise.resolve(categoryRow(where.id)),
    );
    prisma.partCategory.findMany.mockImplementation(() =>
      Promise.resolve([...categories.values()].map(counted)),
    );
    prisma.partCategory.update.mockImplementation(({ where, data }: any) => {
      Object.assign(categories.get(where.id), data);
      return Promise.resolve(categoryRow(where.id));
    });
    prisma.order.findUnique.mockImplementation(() => Promise.resolve(order));
    prisma.orderItem.findMany.mockImplementation(() => Promise.resolve(lines));
    prisma.catalogPart.findMany.mockImplementation(({ where }: any) =>
      Promise.resolve(
        where.id.in
          .filter((id: string) => parts.has(id))
          .map((id: string) => ({
            ...parts.get(id),
            category: categoryRow(parts.get(id).categoryId),
          })),
      ),
    );
    prisma.providerServiceOffering.findMany.mockImplementation(
      ({ where }: any) =>
        Promise.resolve(
          where.id.in
            .filter((id: string) => offerings.has(id))
            .map((id: string) => ({
              id,
              provider: offerings.get(id).provider,
              category: categoryRow(offerings.get(id).categoryId),
            })),
        ),
    );
    prisma.sourcingOffer.findMany.mockImplementation(({ where }: any) =>
      Promise.resolve(
        where.id.in
          .filter((id: string) => offers.has(id))
          .map((id: string) => ({
            id,
            packageForm: null,
            category: categoryRow(offers.get(id).categoryId),
          })),
      ),
    );
    // The payments table, for as far as an invoice goes: the rows a transaction can take.
    prisma.payment.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(
        where.providerTransactionId === null
          ? ([...invoices]
              .reverse()
              .find((row) => row.providerTransactionId === null) ?? null)
          : (invoices.find(
              (row) => row.providerState === where.providerState,
            ) ?? null),
      ),
    );
    prisma.payment.findUnique.mockImplementation(({ where }: any) =>
      Promise.resolve(
        invoices.find(
          (row) =>
            where.provider_providerTransactionId &&
            row.providerTransactionId ===
              where.provider_providerTransactionId.providerTransactionId,
        ) ?? null,
      ),
    );
    prisma.payment.create.mockImplementation(({ data }: any) => {
      const { fiscalSnapshot, ...row } = data;
      const invoice = {
        providerTransactionId: null,
        providerState: null,
        ...row,
        // As a jsonb column gives it back: a copy, not the object that was written.
        fiscalSnapshot: {
          ...fiscalSnapshot.create,
          detail: JSON.parse(JSON.stringify(fiscalSnapshot.create.detail)),
        },
      };
      invoices.push(invoice);
      return Promise.resolve(invoice);
    });
    prisma.payment.update.mockImplementation(({ where, data }: any) => {
      const row = invoices.find((invoice) => invoice.id === where.id);
      Object.assign(row, data);
      return Promise.resolve(row);
    });
    const receiptKey = (key: any) => `${key.paymentId}:${key.type}`;
    prisma.paymeFiscalReceipt.findUnique.mockImplementation(({ where }: any) =>
      Promise.resolve(receipts.get(receiptKey(where.paymentId_type)) ?? null),
    );
    prisma.paymeFiscalReceipt.create.mockImplementation(({ data }: any) => {
      const row = { conflictCount: 0, ...data };
      receipts.set(receiptKey(data), row);
      return Promise.resolve(row);
    });
    prisma.paymeFiscalReceipt.updateMany.mockImplementation(
      ({ where, data }: any) => {
        const row = receipts.get(receiptKey(where));
        if (!row || row.statusCode === 0) return Promise.resolve({ count: 0 });
        Object.assign(row, data);
        return Promise.resolve({ count: 1 });
      },
    );
    prisma.paymeFiscalReceipt.update.mockImplementation(
      ({ where, data }: any) => {
        const row = receipts.get(receiptKey(where.paymentId_type));
        Object.assign(row, data, {
          conflictCount: row.conflictCount + data.conflictCount.increment,
        });
        return Promise.resolve(row);
      },
    );
    prisma.seller.findMany.mockResolvedValue([
      { id: 7, tgId: BigInt(555), catalogSellerId: 'dealer-1' },
    ]);
    prisma.catalogSeller.findMany.mockResolvedValue([
      { id: 'dealer-1', tin: DEALER.tin, vatPercent: DEALER.vatPercent },
    ]);

    const moduleRef = await Test.createTestingModule({
      controllers: [PaymentWebhookController, AdminCategoriesController],
      providers: [
        PaymeService,
        PaymeFiscalService,
        PaymeFiscalReceiptService,
        PaymentsService,
        AdminCategoriesService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => env[key] },
        },
        { provide: SettlementService, useValue: {} },
        { provide: ClickService, useValue: {} },
        { provide: AdminCategoryTransferService, useValue: {} },
        {
          provide: PartCategoryService,
          useValue: { invalidate: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: AdminAuditService, useValue: fakeAudit() },
      ],
    })
      // The token check only. The role guard stays real, so the roles are too.
      .overrideGuard(AdminJwtGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest().user = {
            id: 'adm_1',
            email: 'operator@example.test',
            name: 'Operator',
            ...admin,
          };
          return true;
        },
      })
      .compile();

    payments = moduleRef.get(PaymentsService);
    app = moduleRef.createNestApplication();
    app.use(PAYME_WEBHOOK_PATH, paymeRawBodyMiddleware);
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  // ── arranging a catalog ───────────────────────────────────────────────────

  const category = (id: string, parentId: string | null, over: any = {}) => {
    const row = {
      id,
      name: id,
      nameRu: id,
      nameUz: id,
      nameEn: id,
      slug: id,
      parentId,
      level: parentId ? 1 : 0,
      sortOrder: 0,
      iconKey: null,
      color: null,
      isActive: true,
      mainCategory: null,
      mxik: null,
      packageCodeSingle: null,
      packageCodeSet: null,
      fiscalConfirmedCodes: null,
      ...over,
    };
    categories.set(id, row);
    return row;
  };
  /** Filed by hand: its own code, as an operator entered it, and not yet confirmed. */
  const subcategory = (id: string, parentId: string, over: any = {}) =>
    category(id, parentId, {
      mxik: SUB_MXIK,
      packageCodeSingle: SUB_PACKAGE,
      ...over,
    });
  /** What the fiscal-confirmation endpoint stores, without going through it. */
  const confirmed = (row: any) => {
    row.fiscalConfirmedCodes = confirmableFiscalCodes(row);
    return row;
  };
  const part = (id: string, categoryId: string, over: any = {}) =>
    parts.set(id, {
      id,
      categoryId,
      packageForm: null,
      kind: ProductKind.SPARE_PART,
      oilType: null,
      inStock: true,
      priceUzs: 100000,
      seller: DEALER,
      ...over,
    });
  const partLine = (partId: string, over: any = {}) => ({
    id: `oi_${lines.length + 1}`,
    partId,
    offerId: null,
    offerSellerTgId: null,
    serviceId: null,
    title: 'Товар',
    quantity: 1,
    priceUzs: 100000,
    lineTotalUzs: 100000,
    ...over,
  });
  const serviceLine = (serviceId: string) =>
    partLine('', { partId: null, serviceId, title: 'Услуга' });
  const offerLine = (offerId: string) =>
    partLine('', {
      partId: null,
      offerId,
      offerSellerTgId: '555',
      title: 'Оффер',
    });
  /** A service with everything a receipt needs. */
  const classifiedService = (id = 'svc_1') => {
    confirmed(subcategory('oil-change-service', 'other-services'));
    offerings.set(id, {
      categoryId: 'oil-change-service',
      provider: { tin: '209876543', vatPercent: 12 },
    });
  };
  /** The order holding these lines, its total derived so that it can add up. */
  const orderOf = (arranged: any[], charges: any = {}) => {
    lines = arranged.map((line, i) => ({ ...line, id: `oi_${i + 1}` }));
    const goods = lines.reduce((sum, line) => sum + line.lineTotalUzs, 0);
    const deliveryUzs = charges.deliveryUzs ?? 0;
    const serviceFeeUzs = charges.serviceFeeUzs ?? 0;
    order = buildOrder({
      id: 'ord_1',
      status: 'PENDING_PAYMENT',
      subtotalUzs: goods,
      deliveryMethod:
        charges.deliveryMethod ?? (deliveryUzs > 0 ? 'COURIER' : 'PICKUP'),
      deliveryUzs,
      serviceFeeUzs,
      discountUzs: 0,
      totalUzs: charges.totalUzs ?? goods + deliveryUzs + serviceFeeUzs,
    });
    return Math.round(Number(order.totalUzs) * 100);
  };

  // ── the requests ──────────────────────────────────────────────────────────

  const rpc = async (method: string, params: any) => {
    const res = await request(app.getHttpServer())
      .post(PAYME_WEBHOOK_PATH)
      .set('Authorization', AUTH)
      .send({ id: 1, method, params });
    // Payme reads anything but a 200 as a transport failure, refusals included.
    expect(res.status).toBe(200);
    return res.body;
  };
  /** The customer starts the payment. A refusal leaves no invoice, nothing more. */
  const startPayment = async () => {
    await payments
      .createPaymeInvoice(order.userId, { order_id: order.id })
      .catch((err: unknown) => {
        if (!(err instanceof HttpException)) throw err;
      });
  };
  /** What Payme is told about the invoice as it stands. */
  const checkAgain = (amount: number) =>
    rpc('CheckPerformTransaction', {
      account: { order_id: 'ord_1' },
      amount,
    });
  /** A payment started from the data as it is now, then Payme's Check of it. */
  const check = async (amount: number) => {
    invoices.length = 0;
    await startPayment();
    return checkAgain(amount);
  };
  const refusedCode = (body: any) => body.error?.code;
  const sumOf = (items: any[]) =>
    items.reduce((sum, item) => sum + item.price * item.count, 0);
  const console_ = () => request(app.getHttpServer());

  // ── scenarios ─────────────────────────────────────────────────────────────

  describe('1. a product on a subcategory with a confirmed MXIK', () => {
    it('is allowed, and its line carries that subcategory’s codes and dealer', async () => {
      confirmed(subcategory('brake-discs', 'brake-system'));
      part('p1', 'brake-discs');

      const body = await check(orderOf([partLine('p1')]));

      expect(body.result.allow).toBe(true);
      expect(body.result.detail.items).toEqual([
        {
          title: 'Товар',
          price: 10_000_000,
          count: 1,
          code: SUB_MXIK,
          package_code: SUB_PACKAGE,
          vat_percent: 12,
          commission_info: { tin: DEALER.tin },
        },
      ]);
    });
  });

  describe('2. a product on a category with no MXIK', () => {
    it('is refused before any transaction exists', async () => {
      category('brake-discs', 'brake-system');
      part('p1', 'brake-discs');
      const amount = orderOf([partLine('p1')]);

      expect(refusedCode(await check(amount))).toBe(REFUSED);

      prisma.payment.findUnique.mockResolvedValue(null);
      const created = await rpc('CreateTransaction', {
        id: 'pmt-1',
        time: Date.now(),
        amount,
        account: { order_id: 'ord_1' },
      });
      expect(refusedCode(created)).toBe(REFUSED);
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });
  });

  describe('3. a product on a category nobody confirmed', () => {
    it('is refused, however plausible the code', async () => {
      subcategory('brake-discs', 'brake-system');
      part('p1', 'brake-discs');

      expect(refusedCode(await check(orderOf([partLine('p1')])))).toBe(REFUSED);
    });
  });

  describe('4. the parent’s code is not inherited', () => {
    it('a subcategory with none is refused beside a confirmed parent', async () => {
      confirmed(category('brake-system', null, { ...CODES_OF('brakes') }));
      category('brake-discs', 'brake-system');
      part('p1', 'brake-discs');

      expect(refusedCode(await check(orderOf([partLine('p1')])))).toBe(REFUSED);
    });

    it('a parent with active subcategories is not sold from, confirmed or not', async () => {
      confirmed(category('brake-system', null, { ...CODES_OF('brakes') }));
      confirmed(subcategory('brake-discs', 'brake-system'));
      part('p1', 'brake-system');

      expect(refusedCode(await check(orderOf([partLine('p1')])))).toBe(REFUSED);
    });

    it('a parent whose only subcategory is deactivated is a leaf again', async () => {
      confirmed(category('brake-system', null, { ...CODES_OF('brakes') }));
      subcategory('brake-discs', 'brake-system', { isActive: false });
      part('p1', 'brake-system');

      const body = await check(orderOf([partLine('p1')]));

      expect(body.result.detail.items[0].code).toBe(CODES_OF('brakes').mxik);
    });
  });

  describe.each([
    ['electrical-parts', 'electrical-and-lighting', 'starters'],
    ['lighting', 'electrical-and-lighting', 'headlights-and-bulbs'],
    ['ignition', 'electrical-and-lighting', 'spark-plugs'],
    ['belts-and-hoses', 'engine-system', 'timing-belt-kits'],
  ])('5. %s', (node, root, sub) => {
    // The brief calls these parents, and the seeded tree has their subcategories as
    // SIBLINGS under the root. Production cannot be inspected from here, so both.
    describe.each([
      ['as the parent of its subcategory', node],
      ['beside its subcategory, as the seeded tree has it', root],
    ])('%s', (_, subParent) => {
      beforeEach(() => {
        category(node, root, { ...CODES_OF(node) });
        confirmed(subcategory(sub, subParent));
      });

      it('a product on the subcategory carries the subcategory’s MXIK', async () => {
        part('p1', sub);

        const body = await check(orderOf([partLine('p1')]));

        expect(body.result.detail.items[0].code).toBe(SUB_MXIK);
        expect(body.result.detail.items[0].code).not.toBe(CODES_OF(node).mxik);
      });

      it('a product left on the node itself is refused', async () => {
        part('p1', node);
        expect(refusedCode(await check(orderOf([partLine('p1')])))).toBe(
          REFUSED,
        );
      });

      it('the console says so, and refuses to confirm it', async () => {
        const row = await console_()
          .get(`/v1/admin/categories/${node}`)
          .expect(200);
        expect(row.body.data).toMatchObject({
          mxik: CODES_OF(node).mxik,
          fiscalStatus: 'NOT_SELLABLE',
          fiscalConfigured: false,
          fiscalCodesToConfirm: null,
        });

        const refused = await console_()
          .patch(`/v1/admin/categories/${node}/fiscal-confirmation`)
          .send({
            confirmed: true,
            codes: `${CODES_OF(node).mxik}:${CODES_OF(node).packageCodeSingle}:`,
          })
          .expect(409);
        expect(refused.body.code).toBe('CATEGORY_NOT_SELLABLE');
        // Its stored code is left as it was.
        expect(categories.get(node).mxik).toBe(CODES_OF(node).mxik);
        expect(categories.get(node).fiscalConfirmedCodes).toBeNull();
      });
    });
  });

  describe('6. the sum of the receipt and the sum of the order', () => {
    it('agree, for several lines, quantities, delivery and the service fee', async () => {
      confirmed(subcategory('brake-discs', 'brake-system'));
      part('p1', 'brake-discs');
      part('p2', 'brake-discs');

      const amount = orderOf(
        [
          partLine('p1', {
            quantity: 3,
            priceUzs: 33333,
            lineTotalUzs: 99999,
          }),
          partLine('p2', { priceUzs: 100001, lineTotalUzs: 100001 }),
        ],
        { deliveryUzs: 25000, serviceFeeUzs: 5000 },
      );
      const body = await check(amount);

      expect(amount).toBe(23_000_000);
      expect(sumOf(body.result.detail.items)).toBe(amount);
    });

    it('a stored total the lines do not add up to is refused', async () => {
      confirmed(subcategory('brake-discs', 'brake-system'));
      part('p1', 'brake-discs');

      const amount = orderOf([partLine('p1')], { totalUzs: 150000 });

      expect(refusedCode(await check(amount))).toBe(REFUSED);
    });

    it('an amount other than the order’s is refused as such', async () => {
      confirmed(subcategory('brake-discs', 'brake-system'));
      part('p1', 'brake-discs');
      orderOf([partLine('p1')]);

      expect(refusedCode(await check(999))).toBe(-31001);
    });
  });

  describe('7. service lines and the order’s other charges', () => {
    it('a classified service, delivery and the fee are all on the receipt', async () => {
      classifiedService();
      confirmed(subcategory('brake-discs', 'brake-system'));
      part('p1', 'brake-discs');

      const amount = orderOf([partLine('p1'), serviceLine('svc_1')], {
        deliveryUzs: 25000,
        serviceFeeUzs: 5000,
      });
      const { items } = (await check(amount)).result.detail;

      expect(items.map((item: any) => [item.title, item.code])).toEqual([
        ['Товар', SUB_MXIK],
        ['Услуга', SUB_MXIK],
        ['Доставка', DELIVERY_MXIK],
        ['Сервисный сбор', BASE_ENV.SERVICE_FEE_MXIK],
      ]);
      expect(items[1].commission_info).toEqual({ tin: '209876543' });
      expect(sumOf(items)).toBe(amount);
    });

    it('an unclassified service beside goods refuses the whole order', async () => {
      offerings.set('svc_1', {
        categoryId: null,
        provider: { tin: '209876543', vatPercent: 12 },
      });
      confirmed(subcategory('brake-discs', 'brake-system'));
      part('p1', 'brake-discs');

      const amount = orderOf([partLine('p1'), serviceLine('svc_1')]);

      expect(refusedCode(await check(amount))).toBe(REFUSED);
    });

    it('a charge whose codes are not configured refuses the order', async () => {
      delete env.SERVICE_FEE_MXIK;
      confirmed(subcategory('brake-discs', 'brake-system'));
      part('p1', 'brake-discs');

      const amount = orderOf([partLine('p1')], { serviceFeeUzs: 5000 });

      expect(refusedCode(await check(amount))).toBe(REFUSED);
    });
  });

  describe.each([
    ['8. PAYME_ALLOW_SERVICE_ONLY_ORDERS=false', 'false'],
    ['10. PAYME_ALLOW_SERVICE_ONLY_ORDERS absent', undefined],
  ])('%s', (_, value) => {
    beforeEach(() => {
      env[FLAG] = value;
    });

    it('an order of services alone is refused, however complete it is', async () => {
      classifiedService();
      const amount = orderOf([serviceLine('svc_1')]);
      expect(refusedCode(await check(amount))).toBe(REFUSED);
    });

    it('goods are not affected', async () => {
      confirmed(subcategory('brake-discs', 'brake-system'));
      part('p1', 'brake-discs');
      const body = await check(orderOf([partLine('p1')]));
      expect(body.result.allow).toBe(true);
    });
  });

  describe('9. PAYME_ALLOW_SERVICE_ONLY_ORDERS=true', () => {
    beforeEach(() => {
      env[FLAG] = 'true';
    });

    it('fully classified services are allowed, with a full receipt', async () => {
      classifiedService();

      const amount = orderOf([serviceLine('svc_1')], {
        deliveryUzs: 25000,
        serviceFeeUzs: 5000,
      });
      const body = await check(amount);

      expect(body.result.allow).toBe(true);
      expect(body.result.detail.items[0]).toMatchObject({
        code: SUB_MXIK,
        package_code: SUB_PACKAGE,
        vat_percent: 12,
        commission_info: { tin: '209876543' },
      });
      expect(sumOf(body.result.detail.items)).toBe(amount);
    });

    it.each<[string, () => void]>([
      [
        'a service with no category',
        () =>
          offerings.set('svc_1', {
            categoryId: null,
            provider: { tin: '209876543', vatPercent: 12 },
          }),
      ],
      [
        'a service whose category nobody confirmed',
        () => {
          subcategory('oil-change-service', 'other-services');
          offerings.set('svc_1', {
            categoryId: 'oil-change-service',
            provider: { tin: '209876543', vatPercent: 12 },
          });
        },
      ],
      [
        'a provider with no tax id',
        () => {
          classifiedService();
          offerings.get('svc_1').provider = { tin: null, vatPercent: 12 };
        },
      ],
      [
        'a provider with no VAT rate',
        () => {
          classifiedService();
          offerings.get('svc_1').provider = {
            tin: '209876543',
            vatPercent: null,
          };
        },
      ],
      ['a service that no longer exists', () => undefined],
    ])(
      '%s is still refused: it is no way around anything',
      async (_, arrange) => {
        arrange();
        const amount = orderOf([serviceLine('svc_1')]);
        expect(refusedCode(await check(amount))).toBe(REFUSED);
      },
    );
  });

  describe.each([
    ['true', 'true'],
    ['false', 'false'],
    ['absent', undefined],
  ])(
    '11. an unknown or unclassified line, with the variable %s',
    (_, value) => {
      beforeEach(() => {
        env[FLAG] = value;
      });

      it('a line stating no part, offer or service is refused', async () => {
        const amount = orderOf([partLine('', { partId: null })]);
        expect(refusedCode(await check(amount))).toBe(REFUSED);
      });

      it('a part in the fallback bucket is refused', async () => {
        confirmed(
          category('cat_uncategorized', null, { ...CODES_OF('brakes') }),
        );
        part('p1', 'cat_uncategorized');
        expect(refusedCode(await check(orderOf([partLine('p1')])))).toBe(
          REFUSED,
        );
      });

      it('a part whose catalog row is gone is refused', async () => {
        expect(refusedCode(await check(orderOf([partLine('gone')])))).toBe(
          REFUSED,
        );
      });

      it('a sourcing offer nobody classified is refused', async () => {
        offers.set('soff_1', { categoryId: null });
        expect(refusedCode(await check(orderOf([offerLine('soff_1')])))).toBe(
          REFUSED,
        );
      });
    },
  );

  describe('delivery, which the customer pays for through Payme', () => {
    const payableGoods = () => {
      confirmed(subcategory('brake-discs', 'brake-system'));
      part('p1', 'brake-discs');
      return partLine('p1');
    };
    const deliveryLines = (items: any[]) =>
      items.filter((item) => item.code === DELIVERY_MXIK);

    it('is a line of its own, with its system code and the order’s own charge', async () => {
      const amount = orderOf([payableGoods()], { deliveryUzs: 37500 });

      const { items } = (await check(amount)).result.detail;

      expect(items).toHaveLength(2);
      expect(items[1]).toEqual({
        title: 'Доставка',
        price: 3_750_000,
        count: 1,
        code: DELIVERY_MXIK,
        package_code: DELIVERY_UNIT_CODE,
        vat_percent: 7,
      });
      expect(sumOf(items)).toBe(amount);
    });

    describe('its stored cost', () => {
      it('goods by courier with none: no transaction, at any step', async () => {
        const amount = orderOf([payableGoods()], {
          deliveryMethod: 'COURIER',
          deliveryUzs: 0,
        });

        expect(refusedCode(await check(amount))).toBe(REFUSED);
        prisma.payment.findUnique.mockResolvedValue(null);
        const created = await rpc('CreateTransaction', {
          id: 'pmt-1',
          time: Date.now(),
          amount,
          account: { order_id: 'ord_1' },
        });
        expect(refusedCode(created)).toBe(REFUSED);
        expect(prisma.payment.create).not.toHaveBeenCalled();
      });

      it('pickup holding one contradicts itself, and is refused', async () => {
        const amount = orderOf([payableGoods()], {
          deliveryMethod: 'PICKUP',
          deliveryUzs: 25000,
        });

        expect(refusedCode(await check(amount))).toBe(REFUSED);
      });

      it('is what the line says, and flat figures left in the environment are not', async () => {
        env.DELIVERY_COURIER_UZS = '25000';
        env.SERVICE_FEE_UZS = '5000';
        const amount = orderOf([payableGoods()], { deliveryUzs: 37500 });

        const { items } = (await check(amount)).result.detail;

        expect(items.map((item: any) => item.title)).toEqual([
          'Товар',
          'Доставка',
        ]);
        expect(items[1].price).toBe(3_750_000);
        expect(sumOf(items)).toBe(amount);
      });

      it('stays what it was from one Check to the next', async () => {
        const amount = orderOf([payableGoods()], { deliveryUzs: 37500 });

        const first = (await check(amount)).result.detail;
        env.DELIVERY_COURIER_UZS = '99000';
        const second = (await checkAgain(amount)).result.detail;

        expect(second).toEqual(first);
        expect(prisma.order.update).not.toHaveBeenCalled();
      });
    });

    describe('its VAT rate', () => {
      it.each<[string, string | undefined]>([
        ['absent', undefined],
        ['blank', ''],
        ['not a number', 'abc'],
        ['written with a sign', '12%'],
        ['out of range', '101'],
      ])('%s: refused, rather than sent as 0', async (_, value) => {
        env.DELIVERY_VAT_PERCENT = value;
        const amount = orderOf([payableGoods()], { deliveryUzs: 25000 });

        expect(refusedCode(await check(amount))).toBe(REFUSED);
      });

      it('stated as 0, it is sent as 0: only the absence of one is refused', async () => {
        env.DELIVERY_VAT_PERCENT = '0';
        const amount = orderOf([payableGoods()], { deliveryUzs: 25000 });

        const { items } = (await check(amount)).result.detail;

        expect(items[1].vat_percent).toBe(0);
      });

      it('a pickup order needs none', async () => {
        delete env.DELIVERY_VAT_PERCENT;
        const amount = orderOf([payableGoods()]);

        expect((await check(amount)).result.allow).toBe(true);
      });
    });

    it('carries the marketplace’s tax id if one is configured, and none otherwise', async () => {
      const amount = orderOf([payableGoods()], { deliveryUzs: 25000 });

      const without = (await check(amount)).result.detail.items[1];
      expect(without).not.toHaveProperty('commission_info');

      env.MARKETPLACE_TIN = '123456789';
      const withTin = (await check(amount)).result.detail.items;
      expect(withTin[1].commission_info).toEqual({ tin: '123456789' });
      // The goods keep their own dealer's.
      expect(withTin[0].commission_info).toEqual({ tin: DEALER.tin });
    });

    it('is no line at all when the order charges none', async () => {
      const amount = orderOf([payableGoods()], { deliveryUzs: 0 });

      const { items } = (await check(amount)).result.detail;

      expect(items).toHaveLength(1);
      expect(deliveryLines(items)).toEqual([]);
    });

    it('is one line, however many goods the order holds', async () => {
      const goods = payableGoods();
      part('p2', 'brake-discs');

      const amount = orderOf([goods, partLine('p2')], { deliveryUzs: 25000 });
      const { items } = (await check(amount)).result.detail;

      expect(deliveryLines(items)).toHaveLength(1);
      expect(sumOf(items)).toBe(amount);
    });

    it('takes no code from the environment, the old one included', async () => {
      env.DELIVERY_MXIK = '05320001001000000';
      env.DELIVERY_PACKAGE_CODE = '1000000';

      const amount = orderOf([payableGoods()], { deliveryUzs: 25000 });
      const { items } = (await check(amount)).result.detail;

      expect(items[1].code).toBe(DELIVERY_MXIK);
      expect(items[1].package_code).toBe(DELIVERY_UNIT_CODE);
      expect(JSON.stringify(items)).not.toContain('05320001001000000');
    });

    it('needs no category and no confirmation, unlike the goods beside it', async () => {
      subcategory('brake-discs', 'brake-system');
      part('p1', 'brake-discs');
      const amount = orderOf([partLine('p1')], { deliveryUzs: 25000 });

      // The goods are what stops this order. Confirming them is all it takes.
      expect(refusedCode(await check(amount))).toBe(REFUSED);
      confirmed(categories.get('brake-discs'));
      expect((await check(amount)).result.allow).toBe(true);
    });

    it.each<[string, unknown]>([
      ['absent', null],
      ['negative', -25000],
    ])('a stored charge that is %s is refused', async (_, deliveryUzs) => {
      const amount = orderOf([payableGoods()]);
      order.deliveryUzs = deliveryUzs;

      expect(refusedCode(await check(amount))).toBe(REFUSED);
    });

    it.each([
      ['false', 'false'],
      ['absent', undefined],
    ])(
      'does not make goods service-only, with the variable %s',
      async (_, value) => {
        env[FLAG] = value;
        const amount = orderOf([payableGoods()], { deliveryUzs: 25000 });

        expect((await check(amount)).result.allow).toBe(true);
      },
    );

    it('does not make services payable with the variable off', async () => {
      env[FLAG] = 'false';
      classifiedService();
      const amount = orderOf([serviceLine('svc_1')], { deliveryUzs: 25000 });

      expect(refusedCode(await check(amount))).toBe(REFUSED);
    });

    it.each([
      ['true', 'true'],
      ['false', 'false'],
      ['absent', undefined],
    ])('is no order by itself, with the variable %s', async (_, value) => {
      env[FLAG] = value;
      const amount = orderOf([], { deliveryUzs: 25000 });

      expect(refusedCode(await check(amount))).toBe(REFUSED);
    });
  });

  describe('one category, one code, whatever kind of line files on it', () => {
    it('a part, a sourcing offer and a service all carry the same MXIK', async () => {
      const shared = confirmed(subcategory('shared-sub', 'a-root'));
      part('p1', 'shared-sub');
      offers.set('soff_1', { categoryId: 'shared-sub' });
      offerings.set('svc_1', {
        categoryId: 'shared-sub',
        provider: { tin: '209876543', vatPercent: 12 },
      });

      const body = await check(
        orderOf([partLine('p1'), offerLine('soff_1'), serviceLine('svc_1')]),
      );

      expect(body.result.detail.items.map((item: any) => item.code)).toEqual([
        shared.mxik,
        shared.mxik,
        shared.mxik,
      ]);
    });
  });

  describe('oils: kind, oil type and category have to agree', () => {
    const SYNTHETIC = 'synthetic-motor-oil';

    it('a composition with its own confirmed code uses that code', async () => {
      confirmed(subcategory(SYNTHETIC, 'motor-oil'));
      part('p1', SYNTHETIC, {
        kind: ProductKind.MOTOR_OIL,
        oilType: OilType.SYNTHETIC,
      });

      const body = await check(orderOf([partLine('p1')]));

      expect(body.result.detail.items[0].code).toBe(SUB_MXIK);
    });

    it('a position an import left as a spare part can sit there', async () => {
      confirmed(subcategory(SYNTHETIC, 'motor-oil'));
      part('p1', SYNTHETIC);

      const body = await check(orderOf([partLine('p1')]));

      expect(body.result.detail.items[0].code).toBe(SUB_MXIK);
    });

    it('with no code of its own it takes the table’s, once confirmed', async () => {
      confirmed(category(SYNTHETIC, 'motor-oil'));
      part('p1', SYNTHETIC, {
        kind: ProductKind.MOTOR_OIL,
        oilType: OilType.SYNTHETIC,
      });

      const body = await check(orderOf([partLine('p1')]));

      expect(body.result.detail.items[0].code).toBe(
        OIL_TYPE_FISCAL[OilType.SYNTHETIC].mxik,
      );
    });

    it('a stated oil type contradicting the category is refused', async () => {
      confirmed(subcategory(SYNTHETIC, 'motor-oil'));
      part('p1', SYNTHETIC, {
        kind: ProductKind.MOTOR_OIL,
        oilType: OilType.MINERAL,
      });

      expect(refusedCode(await check(orderOf([partLine('p1')])))).toBe(REFUSED);
    });

    it('a motor oil on a brake category is refused, whatever its name says', async () => {
      confirmed(subcategory('brake-discs', 'brake-system'));
      part('p1', 'brake-discs', { kind: ProductKind.MOTOR_OIL });
      const amount = orderOf([partLine('p1', { title: 'Масло тормозное' })]);

      expect(refusedCode(await check(amount))).toBe(REFUSED);
    });
  });

  describe('the confirmation reaches the receipt, through the API', () => {
    const CODES = `${SUB_MXIK}:${SUB_PACKAGE}:`;
    const confirm = (codes: string) =>
      console_()
        .patch('/v1/admin/categories/brake-discs/fiscal-confirmation')
        .send({ confirmed: true, codes });
    const edit = (body: any) =>
      console_().patch('/v1/admin/categories/brake-discs').send(body);
    const listed = async (status: string) =>
      (
        await console_()
          .get(`/v1/admin/categories?fiscalStatus=${status}`)
          .expect(200)
      ).body.data.map((row: any) => row.id);

    beforeEach(() => {
      category('brake-system', null);
      subcategory('brake-discs', 'brake-system');
      category('brake-pads', 'brake-system');
      part('p1', 'brake-discs');
    });

    it('from waiting, to confirmed, to voided by an edit, to confirmed again', async () => {
      const amount = orderOf([partLine('p1')]);

      // Waiting: it has a code, and the receipt will not take it.
      expect(await listed('NEEDS_CONFIRMATION')).toEqual(['brake-discs']);
      expect(await listed('NEEDS_CODES')).toEqual(['brake-pads']);
      expect(await listed('NOT_SELLABLE')).toEqual(['brake-system']);
      expect(refusedCode(await check(amount))).toBe(REFUSED);

      // Confirmed: stored, and the receipt reads it.
      await confirm(CODES).expect(200);
      expect(categories.get('brake-discs').fiscalConfirmedCodes).toBe(CODES);
      expect(await listed('READY')).toEqual(['brake-discs']);
      expect((await check(amount)).result.detail.items[0].code).toBe(SUB_MXIK);

      // A new MXIK ends it, and an old confirmation is refused as out of date.
      await edit({ mxik: '09922222222222222' }).expect(200);
      expect(categories.get('brake-discs').fiscalConfirmedCodes).toBeNull();
      expect(refusedCode(await check(amount))).toBe(REFUSED);
      const stale = await confirm(CODES).expect(409);
      expect(stale.body.code).toBe('FISCAL_CODES_CHANGED');

      // Changing it back does not bring the old confirmation back.
      await edit({ mxik: SUB_MXIK }).expect(200);
      expect(await listed('NEEDS_CONFIRMATION')).toEqual(['brake-discs']);
      expect(refusedCode(await check(amount))).toBe(REFUSED);

      await confirm(CODES).expect(200);
      expect((await check(amount)).result.allow).toBe(true);
    });

    it('a new package code ends it too', async () => {
      const amount = orderOf([partLine('p1')]);
      await confirm(CODES).expect(200);

      await edit({ packageCodeSingle: '1000099' }).expect(200);

      expect(refusedCode(await check(amount))).toBe(REFUSED);
    });

    it('can be withdrawn', async () => {
      const amount = orderOf([partLine('p1')]);
      await confirm(CODES).expect(200);

      await console_()
        .patch('/v1/admin/categories/brake-discs/fiscal-confirmation')
        .send({ confirmed: false })
        .expect(200);

      expect(refusedCode(await check(amount))).toBe(REFUSED);
    });

    it('takes a manager or a super admin, not an operator', async () => {
      admin.role = 'OPERATOR';
      await confirm(CODES).expect(403);
      expect(categories.get('brake-discs').fiscalConfirmedCodes).toBeNull();

      admin.role = 'MANAGER';
      await confirm(CODES).expect(200);
    });

    it('rejects a status it does not know', async () => {
      await console_()
        .get('/v1/admin/categories?fiscalStatus=MAYBE')
        .expect(400);
    });
  });
  describe('the receipt is frozen on the invoice', () => {
    const payable = () => {
      confirmed(subcategory('brake-discs', 'brake-system'));
      part('p1', 'brake-discs');
      return orderOf([partLine('p1')]);
    };
    const createTransaction = (amount: number, id = 'pmt-1') =>
      rpc('CreateTransaction', {
        id,
        time: Date.now(),
        amount,
        account: { order_id: 'ord_1' },
      });

    it('a code an operator changes after the invoice does not reach Check', async () => {
      const amount = payable();
      const agreed = (await check(amount)).result.detail;

      // Through the console, as an operator would: a new code ends the confirmation,
      // which would refuse a receipt built from the catalog now.
      await console_()
        .patch('/v1/admin/categories/brake-discs')
        .send({ mxik: '09922222222222222' })
        .expect(200);

      const body = await checkAgain(amount);
      expect(body.result.allow).toBe(true);
      expect(body.result.detail).toEqual(agreed);
      expect(body.result.detail.items[0].code).toBe(SUB_MXIK);
    });

    it('a dealer’s new VAT rate and tax id do not reach it either', async () => {
      const amount = payable();
      const agreed = (await check(amount)).result.detail;

      parts.get('p1').seller = { status: 'ACTIVE', tin: '999999999', vatPercent: 0 };

      expect((await checkAgain(amount)).result.detail).toEqual(agreed);
    });

    it('nor a product re-filed on another category', async () => {
      const amount = payable();
      const agreed = (await check(amount)).result.detail;

      confirmed(
        subcategory('other-discs', 'brake-system', { mxik: '09933333333333333' }),
      );
      parts.get('p1').categoryId = 'other-discs';

      expect((await checkAgain(amount)).result.detail).toEqual(agreed);
    });

    it('a second tap on Pay keeps the invoice and the receipt, whatever changed', async () => {
      const amount = payable();
      await startPayment();
      const [invoice] = invoices;
      const agreed = invoice.fiscalSnapshot;
      parts.get('p1').seller = { status: 'ACTIVE', tin: '999999999', vatPercent: 0 };

      await startPayment();

      expect(invoices).toHaveLength(1);
      expect(invoices[0].fiscalSnapshot).toBe(agreed);
    });

    it('the transaction takes the invoice Check described, and the receipt with it', async () => {
      const amount = payable();
      const agreed = (await check(amount)).result.detail;

      const created = await createTransaction(amount);

      expect(created.result.transaction).toBe(invoices[0].id);
      expect(invoices).toHaveLength(1);
      expect(invoices[0].providerTransactionId).toBe('pmt-1');
      expect(invoices[0].fiscalSnapshot.detail).toEqual(agreed);
    });

    it('with the invoice taken, the next payment gets a receipt of its own, from the data by then', async () => {
      const amount = payable();
      await check(amount);
      await createTransaction(amount);
      invoices[0].providerState = -1; // Payme cancelled that attempt.
      invoices[0].status = 'CANCELLED';
      const first = invoices[0].fiscalSnapshot.detail;

      parts.get('p1').seller = { status: 'ACTIVE', tin: '999999999', vatPercent: 0 };
      await startPayment();

      expect(invoices).toHaveLength(2);
      expect(invoices[1].fiscalSnapshot.detail.items[0].commission_info).toEqual({
        tin: '999999999',
      });
      expect(first.items[0].commission_info).toEqual({ tin: DEALER.tin });
    });

    it('Check and Create refuse with no invoice: a link left over from a cancelled attempt', async () => {
      const amount = payable();
      expect(refusedCode(await checkAgain(amount))).toBe(REFUSED);
      expect(refusedCode(await createTransaction(amount))).toBe(REFUSED);
    });

    it('a refused payment leaves no invoice behind for Check to find', async () => {
      subcategory('brake-discs', 'brake-system');
      part('p1', 'brake-discs');
      const amount = orderOf([partLine('p1')]);

      await startPayment();

      expect(invoices).toEqual([]);
      expect(refusedCode(await checkAgain(amount))).toBe(REFUSED);
    });
  });

  describe('SetFiscalData', () => {
    /** Payme's own sample, from its documentation. */
    const FISCAL_DATA = {
      receipt_id: 121,
      status_code: 0,
      message: 'accepted',
      terminal_id: 'EP000000000025',
      fiscal_sign: '800031554082',
      qr_code_url: 'fiscal receipt url',
      date: '20220706221021',
    };
    const setFiscalData = (
      type: string,
      data: any = FISCAL_DATA,
      id = 'pmt-1',
    ) => rpc('SetFiscalData', { id, type, fiscal_data: data });

    beforeEach(async () => {
      confirmed(subcategory('brake-discs', 'brake-system'));
      part('p1', 'brake-discs');
      const amount = orderOf([partLine('p1')]);
      await check(amount);
      await rpc('CreateTransaction', {
        id: 'pmt-1',
        time: Date.now(),
        amount,
        account: { order_id: 'ord_1' },
      });
      invoices[0].providerState = 2;
    });
    const stored = (type: string) =>
      receipts.get(`${invoices[0].id}:${type}`);

    it('takes the documented call and answers what the documentation says', async () => {
      const body = await setFiscalData('PERFORM');

      expect(body.error).toBeUndefined();
      expect(body.result).toEqual({ success: true });
      expect(stored('PERFORM')).toMatchObject({
        receiptId: '121',
        statusCode: 0,
        terminalId: 'EP000000000025',
        fiscalSign: '800031554082',
        qrCodeUrl: 'fiscal receipt url',
        fiscalDate: '20220706221021',
        rawData: FISCAL_DATA,
      });
    });

    it('keeps the receipts of a sale and of its cancellation apart', async () => {
      await setFiscalData('PERFORM');
      invoices[0].providerState = -2;
      await setFiscalData('CANCEL', {
        ...FISCAL_DATA,
        receipt_id: 123,
        fiscal_sign: '900031555055',
        date: '20220706231125',
      });

      expect(receipts.size).toBe(2);
      expect(stored('PERFORM').fiscalSign).toBe('800031554082');
      expect(stored('CANCEL').fiscalSign).toBe('900031555055');
    });

    it('a repeated callback changes nothing and still succeeds', async () => {
      await setFiscalData('PERFORM');
      const body = await setFiscalData('PERFORM');

      expect(body.result).toEqual({ success: true });
      expect(receipts.size).toBe(1);
      expect(prisma.paymeFiscalReceipt.create).toHaveBeenCalledTimes(1);
      expect(prisma.paymeFiscalReceipt.updateMany).not.toHaveBeenCalled();
    });

    it('answers -32001 with a plain message for a check we do not know', async () => {
      const body = await setFiscalData('PERFORM', FISCAL_DATA, 'pmt-unknown');
      expect(body.error).toEqual({
        code: -32001,
        message: 'Чек с таким id не найден',
      });
    });

    it.each([
      ['type', { id: 'pmt-1', type: 'REFUND', fiscal_data: FISCAL_DATA }],
      ['id', { type: 'PERFORM', fiscal_data: FISCAL_DATA }],
      ['fiscal_data', { id: 'pmt-1', type: 'PERFORM' }],
      [
        'fiscal_data.status_code',
        {
          id: 'pmt-1',
          type: 'PERFORM',
          fiscal_data: { ...FISCAL_DATA, status_code: 'accepted' },
        },
      ],
    ])('answers -32602 naming %s in the message', async (field, params) => {
      const body = await rpc('SetFiscalData', params);
      expect(body.error).toEqual({ code: -32602, message: field });
      expect(receipts.size).toBe(0);
    });

    it('answers -32504 without the merchant key, and stores nothing', async () => {
      const res = await request(app.getHttpServer())
        .post(PAYME_WEBHOOK_PATH)
        .set('Authorization', 'Basic d3Jvbmc6d3Jvbmc=')
        .send({
          id: 1,
          method: 'SetFiscalData',
          params: { id: 'pmt-1', type: 'PERFORM', fiscal_data: FISCAL_DATA },
        });
      expect(res.status).toBe(200);
      expect(res.body.error.code).toBe(-32504);
      expect(receipts.size).toBe(0);
    });
  });
});

/** The codes the seed, and a migration, put on a node. */
function CODES_OF(id: string) {
  const { mxik, packageCodeSingle } = CATEGORY_FISCAL_DATA[id];
  return { mxik, packageCodeSingle };
}
