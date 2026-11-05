/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * What creating a Payme invoice freezes, and when it freezes nothing new.
 *
 * The rows live in memory and the lookup is reproduced here (its exact `where` is pinned
 * in payme.service.spec.ts), so this says nothing about PostgreSQL: not the row lock,
 * nor the trigger that keeps a snapshot from being updated.
 */
import { HttpException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import {
  buildOrder,
  createPrismaMock,
  fakeConfig,
  fakeFiscal,
  FISCAL_TEST_ENV,
  PrismaMock,
  stubFiscalizableOrderLines,
} from '../../test/utils/harness';

const ENV = {
  ...FISCAL_TEST_ENV,
  PAYME_MERCHANT_ID: 'merchant-1',
  PAYME_ACCOUNT_FIELD: 'order_id',
};

describe('PaymentsService.createPaymeInvoice', () => {
  let prisma: PrismaMock;
  let service: PaymentsService;
  let rows: any[];
  const now = new Date('2026-11-04T10:00:00Z');
  const WINDOW = new Date('2026-11-04T10:30:00Z');
  const INVOICE = { order_id: 'ord_1' } as any;

  beforeEach(() => {
    jest.useFakeTimers({ now });
    rows = [];
    prisma = createPrismaMock();
    prisma.order.findUnique.mockResolvedValue(
      buildOrder({
        id: 'ord_1',
        userId: 'usr_1',
        status: 'PENDING_PAYMENT',
        totalUzs: 215000,
        expiresAt: WINDOW,
      }),
    );
    stubFiscalizableOrderLines(prisma);
    prisma.payment.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(
        [...rows]
          .reverse()
          .find(
            (row) =>
              row.orderId === where.orderId &&
              row.providerTransactionId === null &&
              row.status === 'PENDING' &&
              row.fiscalSnapshot &&
              (row.expiresAt === null || row.expiresAt > now),
          ) ?? null,
      ),
    );
    prisma.payment.create.mockImplementation(({ data }: any) => {
      const row = {
        providerTransactionId: null,
        ...data,
        fiscalSnapshot: data.fiscalSnapshot.create,
      };
      rows.push(row);
      return Promise.resolve(row);
    });
    prisma.payment.update.mockImplementation(({ where, data }: any) => {
      const row = rows.find((r) => r.id === where.id);
      Object.assign(row, data);
      return Promise.resolve(row);
    });
    service = new PaymentsService(
      prisma,
      fakeConfig(ENV),
      fakeFiscal(prisma, ENV),
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** The same part, with the dealer's tax data changed since. */
  const dealerChanged = async () => {
    const [part] = await prisma.catalogPart.findMany({} as any);
    prisma.catalogPart.findMany.mockResolvedValue([
      {
        ...part,
        seller: { status: 'ACTIVE', tin: '999999999', vatPercent: 12 },
      },
    ]);
  };

  it('freezes the receipt the checks passed, with what it adds up to', async () => {
    const res = await service.createPaymeInvoice('usr_1', INVOICE);

    expect(res.amount_tiyin).toBe(21_500_000);
    expect(prisma.payment.create).toHaveBeenCalledTimes(1);
    const { fiscalSnapshot } = rows[0];
    expect(fiscalSnapshot.totalTiyin).toBe(BigInt(21_500_000));
    expect(fiscalSnapshot.detail.receipt_type).toBe(0);
    expect(
      fiscalSnapshot.detail.items.reduce(
        (sum: number, item: any) => sum + item.price * item.count,
        0,
      ),
    ).toBe(21_500_000);
    expect(fiscalSnapshot.detail.items[0]).toMatchObject({
      code: '08708005011000000',
      package_code: '1417722',
      vat_percent: 0,
      commission_info: { tin: '301234567' },
    });
  });

  it('writes the invoice and its receipt in one write, under the order lock', async () => {
    await service.createPaymeInvoice('usr_1', INVOICE);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const sql = (prisma.$queryRaw as jest.Mock).mock.calls[0][0] as string[];
    expect(sql.join('?')).toMatch(
      /SELECT id FROM orders WHERE id = \? FOR UPDATE/,
    );
    expect(prisma.payment.create.mock.calls[0][0].data.fiscalSnapshot).toEqual({
      create: expect.objectContaining({ totalTiyin: BigInt(21_500_000) }),
    });
  });

  it('a second tap keeps the invoice and what it froze, and only refreshes the link', async () => {
    const first = await service.createPaymeInvoice('usr_1', INVOICE);
    const agreed = rows[0].fiscalSnapshot;
    await dealerChanged();

    const second = await service.createPaymeInvoice('usr_1', {
      ...INVOICE,
      return_url: 'mator://payment-return',
    });

    expect(second.payment_id).toBe(first.payment_id);
    expect(prisma.payment.create).toHaveBeenCalledTimes(1);
    expect(rows[0].fiscalSnapshot).toBe(agreed);
    const { data } = prisma.payment.update.mock.calls[0][0];
    expect(Object.keys(data).sort()).toEqual(['deepLink', 'httpsFallback']);
  });

  it('once a transaction took the invoice, the next one freezes its own receipt', async () => {
    await service.createPaymeInvoice('usr_1', INVOICE);
    rows[0].providerTransactionId = 'pmt-1';
    await dealerChanged();

    await service.createPaymeInvoice('usr_1', INVOICE);

    expect(rows).toHaveLength(2);
    expect(rows[0].fiscalSnapshot.detail.items[0].commission_info.tin).toBe(
      '301234567',
    );
    expect(rows[1].fiscalSnapshot.detail.items[0].commission_info.tin).toBe(
      '999999999',
    );
  });

  it('an invoice past its window is not reused: an old receipt is not kept alive', async () => {
    await service.createPaymeInvoice('usr_1', INVOICE);
    rows[0].expiresAt = new Date('2026-11-04T09:59:00Z');

    await service.createPaymeInvoice('usr_1', INVOICE);

    expect(rows).toHaveLength(2);
  });

  it('an older row holding no receipt is not reused', async () => {
    rows.push({
      id: 'pay_old',
      orderId: 'ord_1',
      providerTransactionId: null,
      status: 'PENDING',
      expiresAt: WINDOW,
    });

    await service.createPaymeInvoice('usr_1', INVOICE);

    expect(rows).toHaveLength(2);
    expect(rows[1].fiscalSnapshot).toBeDefined();
  });

  it('reports the window of the invoice it hands out', async () => {
    const res = await service.createPaymeInvoice('usr_1', INVOICE);
    expect(res.expires_at).toBe(WINDOW.toISOString());
  });

  describe('a refused order leaves no invoice behind', () => {
    const refused = async () => {
      await expect(
        service.createPaymeInvoice('usr_1', INVOICE),
      ).rejects.toBeInstanceOf(HttpException);
      expect(prisma.payment.create).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(rows).toEqual([]);
    };

    it.each([
      ['no lines at all', []],
      [
        'a line that states nothing',
        [{ id: 'oi_1', title: 'Запчасть', quantity: 1, priceUzs: 185000 }],
      ],
      [
        'a sourcing offer nobody has classified',
        [
          {
            id: 'oi_1',
            offerId: 'soff_1',
            offerSellerTgId: '555',
            title: 'Стартер',
            quantity: 1,
            priceUzs: 185000,
          },
        ],
      ],
    ])('%s', async (_, lines) => {
      prisma.orderItem.findMany.mockResolvedValue(lines);
      prisma.sourcingOffer.findMany.mockResolvedValue([
        { id: 'soff_1', packageForm: null, category: null },
      ]);
      await refused();
    });

    it('a dealer with no tax data', async () => {
      prisma.catalogPart.findMany.mockResolvedValue([
        {
          id: 'part_1',
          packageForm: 'SINGLE',
          kind: 'SPARE_PART',
          oilType: null,
          inStock: true,
          priceUzs: 185000,
          category: null,
          seller: { status: 'ACTIVE', tin: null, vatPercent: null },
        },
      ]);
      await refused();
    });
  });
});
