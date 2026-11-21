import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

/**
 * An order an operator now has to take up: check the goods, hand them to a courier
 * or get them ready for pickup. Raised at the moment that becomes true:
 *   • `placed` — a cash or terminal order was placed. Nothing is paid online, so it
 *     can be taken up at once;
 *   • `paid`   — an online payment for an order was settled.
 * An online order that is placed but not paid yet is not raised: it may never be
 * paid, and nothing should be sent before it is.
 *
 * Delivered by AlertingModule (OrderNoticeService) to the operators' Telegram chat.
 * Through an event, so checkout and settlement do not depend on Telegram: with no
 * listener nothing happens. Raising never throws and never holds up the caller.
 */
export const ORDER_NOTICE_EVENT = 'orders.notice';

export type OrderNoticeTrigger = 'placed' | 'paid';

export interface OrderNotice {
  orderId: string;
  trigger: OrderNoticeTrigger;
}

@Injectable()
export class OrderNotices {
  private readonly logger = new Logger(OrderNotices.name);

  constructor(@Optional() private readonly events?: EventEmitter2) {}

  /** A cash or terminal order was just placed. */
  placed(orderId: string): void {
    this.raise({ orderId, trigger: 'placed' });
  }

  /** The online payment for this order was just settled. */
  paid(orderId: string): void {
    this.raise({ orderId, trigger: 'paid' });
  }

  private raise(notice: OrderNotice): void {
    try {
      this.events?.emit(ORDER_NOTICE_EVENT, notice);
    } catch (err) {
      this.logger.error(
        `Order ${notice.orderId}: ${notice.trigger} notice could not be handed on: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
