/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A provider not listed in PAYMENT_PROVIDERS moves no money: no checkout link,
 * no payment row, no callback acted on. `PAYMENT_PROVIDERS=` (empty, as on a
 * staging server) lists nothing and so disables Payme and Click alike, while an
 * env that never sets the variable keeps the default: Payme on, as in
 * production today.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { PaymentsService } from './payments.service';
import { ClickService } from './webhooks/click.service';
import {
  enabledPaymentProviders,
  isClickEnabled,
  isPaymeEnabled,
} from './webhooks/click.config';
import { PaymeService } from './webhooks/payme.service';
import { PaymeFiscalReceiptService } from './webhooks/payme-fiscal-receipt.service';
import {
  buildOrder,
  createPrismaMock,
  fakeConfig,
  fakeFiscal,
  FISCAL_TEST_ENV,
  PrismaMock,
  stubFiscalizableOrderLines,
} from '../../test/utils/harness';

const PAYME_KEY = 'merchant-secret';
const PAYME_AUTH =
  'Basic ' + Buffer.from(`Paycom:${PAYME_KEY}`).toString('base64');
/** Everything a working Payme and Click would need: only the list decides. */
const CREDENTIALS = {
  ...FISCAL_TEST_ENV,
  PAYME_MERCHANT_ID: 'merchant-1',
  PAYME_MERCHANT_KEY: PAYME_KEY,
  PAYME_ACCOUNT_FIELD: 'order_id',
  CLICK_SECRET_KEY: 'click-secret',
  CLICK_SERVICE_ID: '98321',
  CLICK_MERCHANT_ID: '44790',
};
/** PAYMENT_PROVIDERS values under which Payme is off. */
const PAYME_OFF = ['', '   ', ',', 'click', 'paym', 'none'];

/** Every Prisma method the mock exposes, none of which may have run. */
function expectNoDatabaseAccess(prisma: PrismaMock) {
  const called: string[] = [];
  const visit = (value: any, path: string) => {
    if (jest.isMockFunction(value)) {
      if (value.mock.calls.length) called.push(path);
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        visit(child, `${path}.${key}`);
      }
    }
  };
  visit(prisma, 'prisma');
  expect(called).toEqual([]);
}

describe('PAYMENT_PROVIDERS parsing', () => {
  const get = (value: string | undefined) => (key: string) =>
    key === 'PAYMENT_PROVIDERS' ? value : undefined;

  it('unset keeps the default: Payme alone', () => {
    expect(enabledPaymentProviders(get(undefined))).toEqual(['payme']);
    expect(isPaymeEnabled(get(undefined))).toBe(true);
  });

  it.each(['', '   ', ',', ' , '])('%j lists no provider at all', (value) => {
    expect(enabledPaymentProviders(get(value))).toEqual([]);
    expect(isPaymeEnabled(get(value))).toBe(false);
  });

  it('`PAYMENT_PROVIDERS=` turns Click off even with its secret', () => {
    const env = (key: string) =>
      key === 'PAYMENT_PROVIDERS' ? '' : (CREDENTIALS as any)[key];
    expect(isClickEnabled(env)).toBe(false);
  });

  it.each([
    ['payme', true],
    [' Payme ', true],
    ['payme,click', true],
    ['click', false],
    ['paym', false],
  ])('%j → Payme enabled: %s', (value, enabled) => {
    expect(isPaymeEnabled(get(value))).toBe(enabled);
  });
});

describe('invoice creation with a provider disabled', () => {
  let prisma: PrismaMock;
  const build = (env: Record<string, string | undefined>) => {
    const all = { ...CREDENTIALS, ...env };
    return new PaymentsService(
      prisma,
      fakeConfig(all),
      fakeFiscal(prisma, all),
    );
  };

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.order.findUnique.mockResolvedValue(
      buildOrder({
        id: 'ord_1',
        userId: 'usr_1',
        status: 'PENDING_PAYMENT',
        totalUzs: 215000,
      }),
    );
    stubFiscalizableOrderLines(prisma);
    jest.clearAllMocks();
  });

  it.each(PAYME_OFF)(
    'PAYMENT_PROVIDERS=%j: Payme answers 400 before reading the order, and records nothing',
    async (value) => {
      const service = build({ PAYMENT_PROVIDERS: value });
      const error = await service
        .createPaymeInvoice('usr_1', { order_id: 'ord_1' } as any)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getStatus()).toBe(400);
      expect((error as BadRequestException).message).toBe(
        'Payme payments are not enabled',
      );
      expectNoDatabaseAccess(prisma);
    },
  );

  it('refuses before validating anything else the request carries', async () => {
    const service = build({ PAYMENT_PROVIDERS: '' });
    await expect(
      service.createPaymeInvoice('usr_1', {
        order_id: 'ord_1',
        return_url: 'https://evil.example/;x=1',
      } as any),
    ).rejects.toThrow('Payme payments are not enabled');
    expectNoDatabaseAccess(prisma);
  });

  it('`PAYMENT_PROVIDERS=` also refuses Click with all of its credentials set', async () => {
    const service = build({ PAYMENT_PROVIDERS: '' });
    await expect(
      service.createClickInvoice('usr_1', { order_id: 'ord_1' } as any),
    ).rejects.toThrow(
      new BadRequestException('Click payments are not enabled'),
    );
    expectNoDatabaseAccess(prisma);
  });

  it.each([
    ['unset (production default)', undefined],
    ['payme', 'payme'],
    ['payme,click', 'payme,click'],
  ])('Payme listed (%s) still goes on to the order', async (_label, value) => {
    prisma.order.findUnique.mockResolvedValue(null);
    const service = build({ PAYMENT_PROVIDERS: value });
    await expect(
      service.createPaymeInvoice('usr_1', { order_id: 'ord_missing' } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.order.findUnique).toHaveBeenCalled();
  });
});

describe('Payme webhook with Payme disabled', () => {
  const METHODS: [string, Record<string, any>][] = [
    [
      'CheckPerformTransaction',
      { amount: 21_500_000, account: { order_id: 'ord_1' } },
    ],
    [
      'CreateTransaction',
      {
        id: 'pmt-1',
        time: Date.now(),
        amount: 21_500_000,
        account: { order_id: 'ord_1' },
      },
    ],
    ['PerformTransaction', { id: 'pmt-1' }],
    ['CancelTransaction', { id: 'pmt-1', reason: 3 }],
    ['CheckTransaction', { id: 'pmt-1' }],
    ['GetStatement', { from: 0, to: Date.now() }],
    ['SetFiscalData', { id: 'pmt-1', type: 'PERFORM', fiscal_data: {} }],
  ];
  let prisma: PrismaMock;
  let settlement: { markPaid: jest.Mock; markCancelled: jest.Mock };
  const build = (env: Record<string, string | undefined>) =>
    new PaymeService(
      prisma,
      fakeConfig({ ...CREDENTIALS, ...env }) as any,
      settlement as any,
      new PaymeFiscalReceiptService(prisma as any),
    );

  beforeEach(() => {
    prisma = createPrismaMock();
    settlement = { markPaid: jest.fn(), markCancelled: jest.fn() };
  });

  it.each(METHODS)(
    '%s, correctly authenticated, is refused without touching an order or a payment',
    async (method, params) => {
      const svc = build({ PAYMENT_PROVIDERS: '' });
      const res: any = await svc.handleRaw(
        PAYME_AUTH,
        Buffer.from(JSON.stringify({ id: 9, method, params })),
      );

      expect(res.id).toBe(9);
      expect(res.result).toBeUndefined();
      expect(res.error.code).toBe(-31008);
      expectNoDatabaseAccess(prisma);
      expect(settlement.markPaid).not.toHaveBeenCalled();
      expect(settlement.markCancelled).not.toHaveBeenCalled();
    },
  );

  it('an unauthenticated caller still gets -32504, not the provider state', async () => {
    const svc = build({ PAYMENT_PROVIDERS: 'click' });
    const res: any = await svc.handle('Basic d3Jvbmc=', {
      id: 1,
      method: 'PerformTransaction',
      params: { id: 'pmt-1' },
    });
    expect(res.error.code).toBe(-32504);
    expectNoDatabaseAccess(prisma);
  });

  it('with Payme listed by default, an authenticated callback is handled as before', async () => {
    prisma.payment.findFirst.mockResolvedValue(null);
    const svc = build({ PAYMENT_PROVIDERS: undefined });
    const res: any = await svc.handle(PAYME_AUTH, {
      id: 1,
      method: 'CheckTransaction',
      params: { id: 'pmt-unknown' },
    });
    // Reaches the transaction lookup: "not found", not "not enabled".
    expect(res.error.code).toBe(-31003);
  });
});

describe('Click webhook with `PAYMENT_PROVIDERS=`', () => {
  const sign = (p: Record<string, unknown>, complete: boolean) => {
    const parts = [
      p.click_trans_id,
      p.service_id,
      'click-secret',
      p.merchant_trans_id,
    ];
    if (complete) parts.push(p.merchant_prepare_id);
    parts.push(p.amount, p.action, p.sign_time);
    return createHash('md5').update(parts.join('')).digest('hex');
  };
  const callback = (complete: boolean) => {
    const p: Record<string, unknown> = {
      click_trans_id: '777',
      service_id: '98321',
      merchant_trans_id: 'ord_1',
      merchant_prepare_id: '1700000000000',
      amount: '215000',
      action: complete ? 1 : 0,
      error: 0,
      sign_time: '2026-11-13 00:00:00',
    };
    return { ...p, sign_string: sign(p, complete) };
  };

  it('a correctly signed Prepare and Complete are refused before any DB access', async () => {
    const prisma = createPrismaMock();
    const settlement = { markPaid: jest.fn(), markCancelled: jest.fn() };
    const svc = new ClickService(
      prisma as never,
      fakeConfig({ ...CREDENTIALS, PAYMENT_PROVIDERS: '' }),
      settlement as never,
    );
    expect((await svc.prepare(callback(false))).error).toBe(-8);
    expect((await svc.complete(callback(true))).error).toBe(-8);
    expectNoDatabaseAccess(prisma);
    expect(settlement.markPaid).not.toHaveBeenCalled();
  });
});
