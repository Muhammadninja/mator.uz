import { DeliveryMethod, OrderStatus, PaymentType } from '@prisma/client';
import type { OrderNoticeTrigger } from '../../orders/order-notices';
import { escapeHtml } from '../alert-message';

/**
 * The Telegram text of an order notice (HTML parse mode, like the alerts).
 *
 * Pure: no bot, no database. In Russian, for the operators who take the order up.
 *
 * It says what is needed to start on the order (what, from which storefront, how much,
 * how it is paid and delivered) and links the admin panel for the rest. It carries no
 * customer data (no name, phone or address): Telegram keeps every message on its own
 * servers, and the panel is where those details already are, behind a login.
 */

/** One order line as the notice shows it. */
export interface OrderNoticeLine {
  title: string;
  quantity: number;
  lineTotalUzs: number;
  /** The storefront that sold it, when the line names one. */
  seller: string | null;
}

/** What the notice is rendered from (read by OrderNoticeService). */
export interface OrderNoticeView {
  id: string;
  status: OrderStatus;
  paymentType: PaymentType | null;
  deliveryMethod: DeliveryMethod | null;
  totalUzs: number;
  deliveryUzs: number;
  items: OrderNoticeLine[];
}

export interface OrderNoticeRenderOptions {
  /** Admin panel base, no trailing slash. Empty: no link. */
  adminPanelUrl: string;
  /** Shown beside the headline when not empty, e.g. `staging`. */
  environmentTag: string;
}

/**
 * Lines listed one by one; any more are counted. With the caps below this keeps the
 * message far under Telegram's 4096 characters, whatever the cart held.
 */
export const MAX_LISTED_LINES = 10;
const MAX_TITLE_CHARS = 80;
const MAX_SELLER_CHARS = 40;

const HEADLINE: Record<OrderNoticeTrigger, string> = {
  placed: '🛒 <b>Новый заказ — оплата при получении</b>',
  paid: '💳 <b>Заказ оплачен онлайн</b>',
};

const PAYMENT_LABEL: Record<PaymentType, string> = {
  [PaymentType.CASH]: 'наличными при получении',
  [PaymentType.TERMINAL]: 'картой через терминал при получении',
  [PaymentType.PAYME]: 'онлайн, Payme',
};

const DELIVERY_LABEL: Record<DeliveryMethod, string> = {
  [DeliveryMethod.COURIER]: 'курьером',
  [DeliveryMethod.PICKUP]: 'самовывоз',
};

const STATUS_LABEL: Record<OrderStatus, string> = {
  [OrderStatus.PENDING_PAYMENT]: 'ждёт оплаты',
  [OrderStatus.PAID]: 'оплачен',
  [OrderStatus.PROCESSING]: 'в обработке',
  [OrderStatus.SHIPPED]: 'отправлен',
  [OrderStatus.DELIVERED]: 'доставлен',
  [OrderStatus.CANCELLED]: 'отменён',
  [OrderStatus.REFUNDED]: 'деньги возвращены',
  [OrderStatus.EXPIRED]: 'истёк',
};

/**
 * Statuses in which nothing is to be sent any more. A notice is rendered when it is
 * delivered, which after retries can be well after the event, so the order may have
 * been cancelled meanwhile: that is said loudly rather than left to be noticed.
 */
const CLOSED_STATUSES: readonly OrderStatus[] = [
  OrderStatus.CANCELLED,
  OrderStatus.REFUNDED,
  OrderStatus.EXPIRED,
];

const PAID_IN_PERSON: readonly PaymentType[] = [
  PaymentType.CASH,
  PaymentType.TERMINAL,
];

export function renderOrderNotice(
  order: OrderNoticeView,
  trigger: OrderNoticeTrigger,
  options: OrderNoticeRenderOptions,
): string {
  const tag = options.environmentTag
    ? ` [${escapeHtml(options.environmentTag)}]`
    : '';
  const lines: string[] = [`${HEADLINE[trigger]}${tag}`, ''];

  lines.push(`Сумма: <b>${formatSum(order.totalUzs)}</b>`);
  if (order.deliveryUzs > 0) {
    lines.push(`в т.ч. доставка: ${formatSum(order.deliveryUzs)}`);
  }
  lines.push(
    `Оплата: ${order.paymentType ? PAYMENT_LABEL[order.paymentType] : 'не указана'}`,
    `Получение: ${order.deliveryMethod ? DELIVERY_LABEL[order.deliveryMethod] : 'не указано'}`,
    statusLine(order),
  );

  lines.push('', `Товары (${order.items.length}):`);
  for (const item of order.items.slice(0, MAX_LISTED_LINES)) {
    lines.push(itemLine(item));
  }
  if (order.items.length > MAX_LISTED_LINES) {
    lines.push(`…и ещё ${order.items.length - MAX_LISTED_LINES}`);
  }

  lines.push('', `Заказ: <code>${escapeHtml(order.id)}</code>`);
  if (options.adminPanelUrl) {
    const href = `${options.adminPanelUrl}/orders/${encodeURIComponent(order.id)}`;
    lines.push(`<a href="${escapeAttribute(href)}">Открыть в админке</a>`);
  }

  return lines.join('\n');
}

function statusLine(order: OrderNoticeView): string {
  if (CLOSED_STATUSES.includes(order.status)) {
    return `⚠️ <b>Статус: ${STATUS_LABEL[order.status]} — не отправлять</b>`;
  }
  // A cash or terminal order waits for an operator, not for a payment: the money is
  // collected on delivery.
  const waitsForOperator =
    order.status === OrderStatus.PENDING_PAYMENT &&
    order.paymentType !== null &&
    PAID_IN_PERSON.includes(order.paymentType);
  return `Статус: ${waitsForOperator ? 'новый, ждёт обработки' : STATUS_LABEL[order.status]}`;
}

function itemLine(item: OrderNoticeLine): string {
  const title = escapeHtml(clip(item.title, MAX_TITLE_CHARS));
  const seller = item.seller
    ? ` (${escapeHtml(clip(item.seller, MAX_SELLER_CHARS))})`
    : '';
  return `• ${title} × ${item.quantity} — ${formatSum(item.lineTotalUzs)}${seller}`;
}

/** `1250000` → `1 250 000 сум`; tiyin are shown only when there are any. */
export function formatSum(amountUzs: number): string {
  const [whole, tiyin] = (Math.round(amountUzs * 100) / 100)
    .toFixed(2)
    .split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return tiyin === '00' ? `${grouped} сум` : `${grouped},${tiyin} сум`;
}

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/** escapeHtml plus the double quote, for a value inside an attribute. */
function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}
