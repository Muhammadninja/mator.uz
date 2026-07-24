import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BookingStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
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

    if (bookings.count || expiredOrders) {
      this.logger.log(`Swept ${bookings.count} expired holds, ${expiredOrders} unpaid orders`);
    }
  }
}
