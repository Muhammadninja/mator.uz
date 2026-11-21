import { DeliveryMethod, OrderStatus, PaymentType } from '@prisma/client';
import {
  MAX_LISTED_LINES,
  formatSum,
  renderOrderNotice,
  type OrderNoticeView,
} from './order-notice.message';

const OPTIONS = {
  adminPanelUrl: 'https://admin.example.uz/ops',
  environmentTag: '',
};

function cashOrder(over: Partial<OrderNoticeView> = {}): OrderNoticeView {
  return {
    id: 'ord_01JD5Q',
    status: OrderStatus.PENDING_PAYMENT,
    paymentType: PaymentType.CASH,
    deliveryMethod: DeliveryMethod.COURIER,
    totalUzs: 1_275_000,
    deliveryUzs: 25_000,
    items: [
      {
        title: 'Фильтр масляный',
        quantity: 2,
        lineTotalUzs: 120_000,
        seller: "Driver's Village",
      },
      {
        title: 'Колодки тормозные',
        quantity: 1,
        lineTotalUzs: 1_130_000,
        seller: null,
      },
    ],
    ...over,
  };
}

describe('renderOrderNotice', () => {
  it('announces a cash order with what is needed to take it up', () => {
    const text = renderOrderNotice(cashOrder(), 'placed', OPTIONS);

    expect(text).toBe(
      [
        '🛒 <b>Новый заказ — оплата при получении</b>',
        '',
        'Сумма: <b>1 275 000 сум</b>',
        'в т.ч. доставка: 25 000 сум',
        'Оплата: наличными при получении',
        'Получение: курьером',
        'Статус: новый, ждёт обработки',
        '',
        'Товары (2):',
        "• Фильтр масляный × 2 — 120 000 сум (Driver's Village)",
        '• Колодки тормозные × 1 — 1 130 000 сум',
        '',
        'Заказ: <code>ord_01JD5Q</code>',
        '<a href="https://admin.example.uz/ops/orders/ord_01JD5Q">Открыть в админке</a>',
      ].join('\n'),
    );
  });

  it('announces a paid online order', () => {
    const text = renderOrderNotice(
      cashOrder({
        status: OrderStatus.PAID,
        paymentType: PaymentType.PAYME,
        deliveryMethod: DeliveryMethod.PICKUP,
        deliveryUzs: 0,
      }),
      'paid',
      OPTIONS,
    );

    expect(text.split('\n')[0]).toBe('💳 <b>Заказ оплачен онлайн</b>');
    expect(text).toContain('Оплата: онлайн, Payme');
    expect(text).toContain('Получение: самовывоз');
    expect(text).toContain('Статус: оплачен');
    // No delivery charge, no delivery line.
    expect(text).not.toContain('доставка');
  });

  it('says loudly when the order was cancelled before the notice went out', () => {
    const text = renderOrderNotice(
      cashOrder({ status: OrderStatus.CANCELLED }),
      'placed',
      OPTIONS,
    );

    expect(text).toContain('⚠️ <b>Статус: отменён — не отправлять</b>');
  });

  it('escapes what customers and dealers typed', () => {
    const text = renderOrderNotice(
      cashOrder({
        items: [
          {
            title: '<script>alert(1)</script> & Co',
            quantity: 1,
            lineTotalUzs: 10,
            seller: 'A<b>B</b>',
          },
        ],
      }),
      'placed',
      OPTIONS,
    );

    expect(text).toContain(
      '• &lt;script&gt;alert(1)&lt;/script&gt; &amp; Co × 1 — 10 сум (A&lt;b&gt;B&lt;/b&gt;)',
    );
    expect(text).not.toContain('<script>');
  });

  it('lists at most MAX_LISTED_LINES lines and counts the rest, clipping long titles', () => {
    const items = Array.from({ length: MAX_LISTED_LINES + 3 }, (_, i) => ({
      title: `${'Очень длинное название запчасти '.repeat(5)}${i}`,
      quantity: 1,
      lineTotalUzs: 1000,
      seller: null,
    }));
    const text = renderOrderNotice(cashOrder({ items }), 'placed', OPTIONS);
    const listed = text.split('\n').filter((line) => line.startsWith('• '));

    expect(listed).toHaveLength(MAX_LISTED_LINES);
    expect(text).toContain(`Товары (${MAX_LISTED_LINES + 3}):`);
    expect(text).toContain('…и ещё 3');
    for (const line of listed) expect(line).toContain('… × 1');
    expect(text.length).toBeLessThan(4096);
  });

  it('omits the link with no admin panel configured, and tags a non-production run', () => {
    const text = renderOrderNotice(cashOrder(), 'placed', {
      adminPanelUrl: '',
      environmentTag: 'staging',
    });

    expect(text.split('\n')[0]).toBe(
      '🛒 <b>Новый заказ — оплата при получении</b> [staging]',
    );
    expect(text).not.toContain('<a href');
  });

  it('carries no customer details', () => {
    const text = renderOrderNotice(cashOrder(), 'placed', OPTIONS);

    expect(text).not.toMatch(/\+?998\d{9}/);
    expect(text).not.toMatch(/телефон|адрес/i);
  });
});

describe('formatSum', () => {
  it('groups thousands and shows tiyin only when there are any', () => {
    expect(formatSum(0)).toBe('0 сум');
    expect(formatSum(999)).toBe('999 сум');
    expect(formatSum(1_250_000)).toBe('1 250 000 сум');
    expect(formatSum(1500.5)).toBe('1 500,50 сум');
  });
});
