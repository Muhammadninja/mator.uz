import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BookingStatus, OrderStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Expires stale booking holds and unpaid orders. Runs every minute because
 * holds are short-lived (5 min). Idempotent — only touches rows already past
 * their expiry.
 */
@Injectable()
export class BookingHoldSweeper {
  private readonly logger = new Logger(BookingHoldSweeper.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'booking-hold-sweep', timeZone: 'UTC' })
  async sweep(): Promise<void> {
    const now = new Date();
    const [bookings, orders] = await Promise.all([
      this.prisma.booking.updateMany({
        where: { status: BookingStatus.HOLD, holdExpiresAt: { lt: now } },
        data: { status: BookingStatus.EXPIRED },
      }),
      this.prisma.order.updateMany({
        where: { status: OrderStatus.PENDING_PAYMENT, expiresAt: { lt: now } },
        data: { status: OrderStatus.EXPIRED },
      }),
    ]);

    if (bookings.count || orders.count) {
      this.logger.log(`Swept ${bookings.count} expired holds, ${orders.count} unpaid orders`);
    }
  }
}
