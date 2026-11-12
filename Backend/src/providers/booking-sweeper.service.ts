import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BookingStatus, NotificationType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrderStatusService } from '../orders/order-status.service';

/**
 * Expires stale booking holds and unpaid orders. Runs every minute because
 * holds are short-lived (5 min). Idempotent — only touches rows already past
 * their expiry. Order expiry is delegated to {@link OrderStatusService} so each
 * EXPIRED transition writes a status-history row like every other status change.
 */
@Injectable()
export class BookingHoldSweeper {
  private readonly logger = new Logger(BookingHoldSweeper.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orderStatus: OrderStatusService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'booking-hold-sweep', timeZone: 'UTC' })
  async sweep(): Promise<void> {
    const now = new Date();
    const [bookings, expiredOrders] = await Promise.all([
      this.prisma.booking.updateMany({
        where: { status: BookingStatus.HOLD, holdExpiresAt: { lt: now } },
        data: { status: BookingStatus.EXPIRED },
      }),
      this.orderStatus.expireOverdue(now),
    ]);

    for (const order of expiredOrders) {
      await this.notifyExpired(order);
    }

    if (bookings.count || expiredOrders.length) {
      this.logger.log(
        `Swept ${bookings.count} expired holds, ${expiredOrders.length} unpaid orders`,
      );
    }
  }

  /** Best effort: the order has already moved, and the next sweep must still run. */
  private async notifyExpired(order: { id: string; userId: string }): Promise<void> {
    try {
      await this.notifications.emit(order.userId, {
        type: NotificationType.ORDER_STATUS_CHANGED,
        title: 'Buyurtma muddati tugadi',
        body: "Buyurtmangiz belgilangan muddatda to'lanmadi va yopildi. Kerak boʻlsa, yangi buyurtma bering.",
        data: { order_id: order.id, status: 'expired' },
        deeplinkPath: '/(tabs)/(cart)/order-confirmation',
      });
    } catch (err) {
      this.logger.error(
        `Could not notify about expired order ${order.id}: ${(err as Error).message}`,
      );
    }
  }
}
