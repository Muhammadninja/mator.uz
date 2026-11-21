import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { OnEvent } from '@nestjs/event-emitter';
import { UnrecoverableError, type Queue } from 'bullmq';
import { Telegraf } from 'telegraf';
import {
  ORDER_NOTICE_EVENT,
  type OrderNotice,
} from '../../orders/order-notices';
import { PrismaService } from '../../prisma/prisma.service';
import { QUEUE_NAMES } from '../../queue/queue.constants';
import {
  RedisTimeoutError,
  assertRedisBacklogRoom,
  withRedisTimeout,
} from '../../redis/redis.service';
import {
  isPermanentTelegramFailure,
  sendTelegramHtml,
} from '../channels/telegram-send';
import {
  ORDER_NOTICE_ATTEMPTS,
  ORDER_NOTICE_BACKOFF_MS,
  resolveOrderNoticeConfig,
  type OrderNoticeConfig,
} from './order-notice.config';
import {
  renderOrderNotice,
  type OrderNoticeView,
} from './order-notice.message';

/** The job name order notices travel under on the alerts queue. */
export const ORDER_NOTICE_JOB = 'order-notice';

/**
 * Longest the event handler waits for the enqueue. BullMQ's connection waits out a Redis
 * outage without limit; past this the handler gives up waiting, and the enqueue still
 * lands once Redis answers (at most once: the job id is deterministic).
 */
export const ORDER_NOTICE_ENQUEUE_TIMEOUT_MS = 5_000;

/**
 * Tells the operators' Telegram chat about an order they have to take up (see
 * src/orders/order-notices.ts for when one is raised).
 *
 * Two halves, like the alerts:
 *   • `handle` (the event listener) only ENQUEUES, on the alerts queue, so checkout and
 *     payment callbacks never wait on Telegram;
 *   • `deliver` runs in AlertProcessor, reads the order as it is now, and sends.
 *     Throwing there is what makes BullMQ retry (ORDER_NOTICE_ATTEMPTS).
 *
 * The bot is the alerts' one, used send-only, like TelegramAlertChannel: it never polls.
 */
@Injectable()
export class OrderNoticeService {
  private readonly logger = new Logger(OrderNoticeService.name);
  private readonly config: OrderNoticeConfig;
  /** Built on first send: a deployment with no chat configured builds nothing. */
  private client?: Telegraf;
  private warnedUnconfigured = false;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
    // Optional so the service can be unit-tested without a BullMQ registration; with no
    // queue it sends inline.
    @Optional()
    @InjectQueue(QUEUE_NAMES.ALERTS)
    private readonly queue?: Queue<OrderNotice>,
  ) {
    this.config = resolveOrderNoticeConfig(config);
  }

  /** On, with a bot token and a chat to send to. */
  get configured(): boolean {
    return (
      this.config.enabled &&
      this.config.botToken !== '' &&
      this.config.chatId !== ''
    );
  }

  /** Never throws: the order is placed or paid whatever happens here. */
  @OnEvent(ORDER_NOTICE_EVENT)
  async handle(notice: OrderNotice): Promise<void> {
    if (!this.configured) {
      this.skipUnconfigured(notice);
      return;
    }
    if (this.queue === undefined) {
      await this.deliverInline(notice);
      return;
    }
    const what = `order notice ${notice.trigger} for ${notice.orderId}`;
    try {
      assertRedisBacklogRoom(what);
      const enqueue = this.queue.add(ORDER_NOTICE_JOB, notice, {
        jobId: orderNoticeJobId(notice),
        attempts: ORDER_NOTICE_ATTEMPTS,
        backoff: { type: 'exponential', delay: ORDER_NOTICE_BACKOFF_MS },
      });
      await withRedisTimeout(
        enqueue,
        ORDER_NOTICE_ENQUEUE_TIMEOUT_MS,
        what,
      ).catch((err: unknown) => {
        if (!(err instanceof RedisTimeoutError)) throw err;
        this.logger.warn(
          `Order ${notice.orderId}: ${notice.trigger} notice not queued within ` +
            `${ORDER_NOTICE_ENQUEUE_TIMEOUT_MS}ms; it is queued once Redis answers.`,
        );
        enqueue.catch((late: unknown) =>
          this.logger.error(
            `Order ${notice.orderId}: ${notice.trigger} notice was never queued: ${message(late)}`,
          ),
        );
      });
    } catch (err) {
      this.logger.error(
        `Order ${notice.orderId}: ${notice.trigger} notice could not be queued: ${message(err)}`,
      );
    }
  }

  /**
   * Send one notice. Called by AlertProcessor for an ORDER_NOTICE_JOB.
   *
   * Throws to have the job retried; throws UnrecoverableError when Telegram refused the
   * request itself (wrong chat, bot removed from it, revoked token), where repeating
   * cannot help. A notice for an order that no longer exists completes without a send.
   */
  async deliver(notice: OrderNotice): Promise<void> {
    if (!this.configured) {
      // Turned off, or the chat was removed, after the notice was queued.
      this.skipUnconfigured(notice);
      return;
    }
    const order = await this.loadOrder(notice.orderId);
    if (order === null) {
      this.logger.warn(
        `Order ${notice.orderId}: not found, ${notice.trigger} notice dropped`,
      );
      return;
    }

    const html = renderOrderNotice(order, notice.trigger, this.config);
    try {
      await sendTelegramHtml(this.bot().telegram, this.config.chatId, html);
    } catch (err) {
      if (isPermanentTelegramFailure(err)) {
        throw new UnrecoverableError(
          `Telegram refused the ${notice.trigger} notice for ${notice.orderId}: ${message(err)}`,
        );
      }
      throw err;
    }
    this.logger.log(
      `Order ${notice.orderId}: ${notice.trigger} notice sent to Telegram`,
    );
  }

  /** The order as the notice shows it, or null when it does not exist. */
  private async loadOrder(orderId: string): Promise<OrderNoticeView | null> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        paymentType: true,
        deliveryMethod: true,
        totalUzs: true,
        deliveryUzs: true,
        items: {
          select: {
            title: true,
            quantity: true,
            lineTotalUzs: true,
            sellerId: true,
          },
          orderBy: { id: 'asc' },
        },
      },
    });
    if (!order) return null;

    const sellerIds = [
      ...new Set(
        order.items
          .map((item) => item.sellerId)
          .filter((id): id is string => !!id),
      ),
    ];
    const sellers =
      sellerIds.length > 0
        ? await this.prisma.catalogSeller.findMany({
            where: { id: { in: sellerIds } },
            select: { id: true, name: true },
          })
        : [];
    const sellerName = new Map(sellers.map((s) => [s.id, s.name]));

    return {
      id: order.id,
      status: order.status,
      paymentType: order.paymentType,
      deliveryMethod: order.deliveryMethod,
      totalUzs: Number(order.totalUzs),
      deliveryUzs: Number(order.deliveryUzs),
      items: order.items.map((item) => ({
        title: item.title,
        quantity: item.quantity,
        lineTotalUzs: Number(item.lineTotalUzs),
        seller: item.sellerId ? (sellerName.get(item.sellerId) ?? null) : null,
      })),
    };
  }

  /** Last-resort direct send, used only with no queue wired (unit context). */
  private async deliverInline(notice: OrderNotice): Promise<void> {
    try {
      await this.deliver(notice);
    } catch (err) {
      this.logger.error(
        `Order ${notice.orderId}: ${notice.trigger} notice FAILED: ${message(err)}`,
      );
    }
  }

  private skipUnconfigured(notice: OrderNotice): void {
    if (this.warnedUnconfigured) {
      this.logger.debug(
        `Order ${notice.orderId}: ${notice.trigger} notice not sent (not configured)`,
      );
      return;
    }
    this.warnedUnconfigured = true;
    this.logger.warn(
      `Order notices are not sent to Telegram: ` +
        (this.config.enabled
          ? 'set ORDER_TELEGRAM_CHAT_ID or ALERT_TELEGRAM_CHAT_ID, and a bot token'
          : 'ORDER_TELEGRAM_NOTIFY is off') +
        `. Order ${notice.orderId} (${notice.trigger}) is logged only.`,
    );
  }

  private bot(): Telegraf {
    this.client ??= new Telegraf(this.config.botToken);
    return this.client;
  }
}

/**
 * `order-notice_<trigger>_<orderId>`: one job per order and trigger, so a repeated
 * event (a retried callback, two instances) is collapsed by BullMQ into one message.
 * Never a `:` (BullMQ refuses a custom id with one), though order ids have none.
 */
export function orderNoticeJobId(notice: OrderNotice): string {
  return `${ORDER_NOTICE_JOB}_${notice.trigger}_${notice.orderId}`.replace(
    /:/g,
    '_',
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
