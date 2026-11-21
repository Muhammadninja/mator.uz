// OrderNoticeService: the event listener (enqueue only) and the worker half (read the
// order, send). The Bot API is replaced by stubbing Telegram.prototype.callApi on the
// REAL Telegraf, so nothing leaves the process and no real token is involved.
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { DeliveryMethod, OrderStatus, PaymentType } from '@prisma/client';
import { UnrecoverableError } from 'bullmq';
import { Telegram } from 'telegraf';
import { OrderNotices, type OrderNotice } from '../../orders/order-notices';
import { PrismaService } from '../../prisma/prisma.service';
import { QUEUE_NAMES } from '../../queue/queue.constants';
import {
  ORDER_NOTICE_ATTEMPTS,
  ORDER_NOTICE_BACKOFF_MS,
} from './order-notice.config';
import {
  ORDER_NOTICE_ENQUEUE_TIMEOUT_MS,
  ORDER_NOTICE_JOB,
  OrderNoticeService,
  orderNoticeJobId,
} from './order-notice.service';

const CONFIGURED = {
  TELEGRAM_BOT_TOKEN: '123456:TEST-TOKEN',
  ALERT_TELEGRAM_CHAT_ID: '-100777',
  ADMIN_PANEL_URL: 'https://admin.example.uz/ops/',
};

const PAID: OrderNotice = { orderId: 'ord_1', trigger: 'paid' };

function configWith(env: Record<string, string>): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

function prismaWith(order: unknown) {
  return {
    order: { findUnique: jest.fn().mockResolvedValue(order) },
    catalogSeller: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'seller_dv', name: "Driver's Village" }]),
    },
  };
}

const ORDER = {
  id: 'ord_1',
  status: OrderStatus.PAID,
  paymentType: PaymentType.PAYME,
  deliveryMethod: DeliveryMethod.COURIER,
  totalUzs: '310000.00',
  deliveryUzs: '25000.00',
  items: [
    {
      title: 'Фильтр масляный',
      quantity: 2,
      lineTotalUzs: '285000.00',
      sellerId: 'seller_dv',
    },
  ],
};

function service(
  env: Record<string, string> = CONFIGURED,
  order: unknown = ORDER,
  queue: unknown = { add: jest.fn().mockResolvedValue({}) },
) {
  const prisma = prismaWith(order);
  const svc = new OrderNoticeService(
    prisma as any,
    configWith(env),
    queue as any,
  );
  return { svc, prisma, queue: queue as { add: jest.Mock } };
}

function stubTelegram(
  answer: (method: string, payload: any) => unknown = () => ({
    message_id: 1,
  }),
) {
  const calls: { method: string; payload: any; opts: any }[] = [];
  jest
    .spyOn(Telegram.prototype as any, 'callApi')
    .mockImplementation((method: any, payload: any, opts: any) => {
      calls.push({ method, payload, opts });
      // A throw inside `answer` becomes a rejection, as a failed API call is.
      return Promise.resolve().then(() => answer(method, payload));
    });
  return calls;
}

function telegramError(code: number, description: string) {
  return Object.assign(new Error(`${code}: ${description}`), {
    code,
    response: { ok: false, error_code: code, description },
  });
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('OrderNoticeService.handle (the event listener)', () => {
  it('enqueues one job per order and trigger on the alerts queue', async () => {
    const { svc, queue } = service();

    await svc.handle(PAID);

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(ORDER_NOTICE_JOB, PAID, {
      jobId: 'order-notice_paid_ord_1',
      attempts: ORDER_NOTICE_ATTEMPTS,
      backoff: { type: 'exponential', delay: ORDER_NOTICE_BACKOFF_MS },
    });
  });

  it('enqueues nothing with no chat configured, and says so once', async () => {
    const { svc, queue } = service({ TELEGRAM_BOT_TOKEN: 't' });
    const warn = jest.spyOn((svc as any).logger, 'warn');

    await svc.handle(PAID);
    await svc.handle({ orderId: 'ord_2', trigger: 'placed' });

    expect(svc.configured).toBe(false);
    expect(queue.add).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('ALERT_TELEGRAM_CHAT_ID');
  });

  it('enqueues nothing when ORDER_TELEGRAM_NOTIFY is off', async () => {
    const { svc, queue } = service({
      ...CONFIGURED,
      ORDER_TELEGRAM_NOTIFY: 'false',
    });

    await svc.handle(PAID);

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('never throws when the enqueue fails: the order is placed regardless', async () => {
    const { svc } = service(CONFIGURED, ORDER, {
      add: jest.fn().mockRejectedValue(new Error('Connection is closed')),
    });

    await expect(svc.handle(PAID)).resolves.toBeUndefined();
  });

  it('stops waiting for an enqueue Redis does not answer', async () => {
    jest.useFakeTimers();
    const { svc } = service(CONFIGURED, ORDER, {
      add: jest.fn().mockReturnValue(new Promise(() => undefined)),
    });

    const handled = svc.handle(PAID);
    await jest.advanceTimersByTimeAsync(ORDER_NOTICE_ENQUEUE_TIMEOUT_MS);

    await expect(handled).resolves.toBeUndefined();
  });

  it('is reached through the event OrderNotices raises', async () => {
    const queue = { add: jest.fn().mockResolvedValue({}) };
    const moduleRef = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [
        OrderNotices,
        OrderNoticeService,
        { provide: ConfigService, useValue: configWith(CONFIGURED) },
        { provide: PrismaService, useValue: prismaWith(ORDER) },
        { provide: getQueueToken(QUEUE_NAMES.ALERTS), useValue: queue },
      ],
    }).compile();
    await moduleRef.init();

    moduleRef.get(OrderNotices).placed('ord_9');
    await new Promise((resolve) => setImmediate(resolve));

    expect(queue.add).toHaveBeenCalledWith(
      ORDER_NOTICE_JOB,
      { orderId: 'ord_9', trigger: 'placed' },
      expect.objectContaining({ jobId: 'order-notice_placed_ord_9' }),
    );
    await moduleRef.close();
  });
});

describe('OrderNoticeService.deliver (the worker half)', () => {
  it('sends the order as it is now to the chat, through a bounded call', async () => {
    const calls = stubTelegram();
    const { svc, prisma } = service();

    await svc.deliver(PAID);

    expect(prisma.order.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'ord_1' } }),
    );
    expect(prisma.catalogSeller.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['seller_dv'] } },
      select: { id: true, name: true },
    });
    expect(calls).toHaveLength(1);
    const [{ method, payload, opts }] = calls;
    expect(method).toBe('sendMessage');
    expect(payload).toMatchObject({
      chat_id: '-100777',
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
    expect(payload.text).toContain('💳 <b>Заказ оплачен онлайн</b>');
    expect(payload.text).toContain('Сумма: <b>310 000 сум</b>');
    expect(payload.text).toContain(
      "• Фильтр масляный × 2 — 285 000 сум (Driver's Village)",
    );
    expect(payload.text).toContain(
      '<a href="https://admin.example.uz/ops/orders/ord_1">',
    );
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends to ORDER_TELEGRAM_CHAT_ID when one is set', async () => {
    const calls = stubTelegram();
    const { svc } = service({
      ...CONFIGURED,
      ORDER_TELEGRAM_CHAT_ID: '-100888',
    });

    await svc.deliver(PAID);

    expect(calls[0].payload.chat_id).toBe('-100888');
  });

  it('drops a notice for an order that no longer exists', async () => {
    const calls = stubTelegram();
    const { svc } = service(CONFIGURED, null);

    await expect(svc.deliver(PAID)).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('sends nothing when the chat was unconfigured after the notice was queued', async () => {
    const calls = stubTelegram();
    const { svc, prisma } = service({ TELEGRAM_BOT_TOKEN: 't' });

    await expect(svc.deliver(PAID)).resolves.toBeUndefined();
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('gives up for good when Telegram refuses the request itself', async () => {
    stubTelegram(() => {
      throw telegramError(403, 'Forbidden: bot was kicked from the group chat');
    });
    const { svc } = service();

    await expect(svc.deliver(PAID)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('rethrows what may pass (429, network) so BullMQ retries it', async () => {
    const limited = telegramError(429, 'Too Many Requests: retry after 3');
    stubTelegram(() => {
      throw limited;
    });
    const { svc } = service();

    await expect(svc.deliver(PAID)).rejects.toBe(limited);

    jest.restoreAllMocks();
    const reset = Object.assign(new Error('socket hang up'), {
      code: 'ECONNRESET',
    });
    stubTelegram(() => {
      throw reset;
    });
    await expect(svc.deliver(PAID)).rejects.toBe(reset);
  });

  it('with no queue wired, sends inline and swallows a failure', async () => {
    stubTelegram(() => {
      throw new Error('socket hang up');
    });
    const prisma = prismaWith(ORDER);
    const svc = new OrderNoticeService(
      prisma as any,
      configWith(CONFIGURED),
      undefined,
    );

    await expect(svc.handle(PAID)).resolves.toBeUndefined();
    expect(prisma.order.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('orderNoticeJobId', () => {
  it('is deterministic per order and trigger, and never carries a colon', () => {
    expect(orderNoticeJobId({ orderId: 'ord_1', trigger: 'placed' })).toBe(
      'order-notice_placed_ord_1',
    );
    expect(orderNoticeJobId({ orderId: 'a:b', trigger: 'paid' })).toBe(
      'order-notice_paid_a_b',
    );
  });
});
