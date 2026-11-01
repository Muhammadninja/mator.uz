import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationType } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  OfflineOrderPolicy,
  readOfflineOrderPolicy,
  waitingOfflineOrders,
} from './offline-order.policy';
import { OrderStatusService } from './order-status.service';

/** One sweep's worth, so a backlog drains over several runs rather than one. */
const SWEEP_BATCH = 200;

/** Marks a delay notice in Notification.data, so an order gets at most one. */
const DELAY_NOTICE_KEY = 'offline_delay_for';

/**
 * Follows up cash and terminal orders no operator has confirmed. Both actions are
 * off until configured (see {@link OfflineOrderPolicy}): each sends a message to a
 * real customer, and expiring closes an order for good.
 */
@Injectable()
export class OfflineOrderMonitorService {
  private readonly logger = new Logger(OfflineOrderMonitorService.name);
  private readonly policy: OfflineOrderPolicy;

  constructor(
    private readonly prisma: PrismaService,
    private readonly orderStatus: OrderStatusService,
    private readonly notifications: NotificationsService,
    config: ConfigService,
  ) {
    this.policy = readOfflineOrderPolicy((key) => config.get<string>(key));
  }

  @Cron(CronExpression.EVERY_5_MINUTES, {
    name: 'offline-order-monitor',
    timeZone: 'UTC',
  })
  async sweep(now: Date = new Date()): Promise<void> {
    await this.expireUnconfirmed(now);
    await this.sendDelayNotices(now);
  }

  /** Tell each customer once that confirming their order is running late. */
  private async sendDelayNotices(now: Date): Promise<void> {
    const { customerNoticeHours } = this.policy;
    if (customerNoticeHours <= 0) return;

    const waiting = await this.prisma.order.findMany({
      where: waitingOfflineOrders(now, customerNoticeHours),
      select: { id: true, userId: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: SWEEP_BATCH,
    });

    for (const order of waiting) {
      const alreadyTold = await this.prisma.notification.findFirst({
        where: {
          userId: order.userId,
          data: { path: [DELAY_NOTICE_KEY], equals: order.id },
        },
        select: { id: true },
      });
      if (alreadyTold) continue;

      await this.notify(order, {
        title: 'Buyurtmangiz tekshirilmoqda',
        body: "Buyurtmangizni tasdiqlash odatdagidan uzoqroq davom etmoqda. Operator tez orada siz bilan bog'lanadi.",
        data: { order_id: order.id, [DELAY_NOTICE_KEY]: order.id },
      });
    }
  }

  private async expireUnconfirmed(now: Date): Promise<void> {
    const { timeoutHours } = this.policy;
    if (timeoutHours <= 0) return;

    const expired = await this.orderStatus.expireUnconfirmedOffline(
      now,
      timeoutHours,
      SWEEP_BATCH,
    );
    for (const order of expired) {
      await this.notify(order, {
        title: 'Buyurtma muddati tugadi',
        body: 'Buyurtmangiz belgilangan muddatda tasdiqlanmadi va yopildi. Kerak boʻlsa, yangi buyurtma bering.',
        data: { order_id: order.id, status: 'expired' },
      });
    }
    if (expired.length > 0) {
      this.logger.log(
        `Expired ${expired.length} cash/terminal order(s) unconfirmed after ${timeoutHours}h`,
      );
    }
  }

  /** Best effort: the order has already moved, and the next sweep must still run. */
  private async notify(
    order: { id: string; userId: string },
    message: { title: string; body: string; data: Record<string, string> },
  ): Promise<void> {
    try {
      await this.notifications.emit(order.userId, {
        type: NotificationType.ORDER_STATUS_CHANGED,
        ...message,
        deeplinkPath: '/(tabs)/(cart)/order-confirmation',
      });
    } catch (err) {
      this.logger.error(
        `Could not notify about order ${order.id}: ${(err as Error).message}`,
      );
    }
  }
}
