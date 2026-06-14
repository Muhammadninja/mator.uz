import { Injectable, Logger } from '@nestjs/common';
import { NotificationType, OrderStatus, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';

/**
 * Final state transitions shared by the Payme and Click webhooks. Idempotent:
 * marking an already-paid payment is a no-op.
 */
@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async markPaid(paymentId: string, performTimeMs?: number): Promise<void> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { order: true },
    });
    if (!payment) return;
    if (payment.status === PaymentStatus.PAID) return; // idempotent

    // Flip payment + order atomically; notify (inbox + push) after the commit.
    await this.prisma.$transaction([
      this.prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: PaymentStatus.PAID,
          paidAt: new Date(),
          providerState: 2,
          providerPerformTime: BigInt(performTimeMs ?? Date.now()),
        },
      }),
      this.prisma.order.update({
        where: { id: payment.orderId },
        data: { status: OrderStatus.PAID },
      }),
    ]);

    await this.notifications.emit(payment.order.userId, {
      type: NotificationType.ORDER_PAID,
      title: "To'lov qabul qilindi",
      body: `${Number(payment.amountUzs).toLocaleString('en-US').replace(/,/g, ' ')} so'mlik buyurtmangiz to'landi.`,
      data: { order_id: payment.orderId, payment_id: payment.id },
      deeplinkPath: '/(tabs)/(cart)/order-confirmation',
    });
    this.logger.log(`Order ${payment.orderId} marked PAID via payment ${paymentId}`);
  }

  async markCancelled(paymentId: string, reason?: number, performedBefore = false): Promise<void> {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) return;
    await this.prisma.$transaction([
      this.prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: performedBefore ? PaymentStatus.REFUNDED : PaymentStatus.CANCELLED,
          providerState: performedBefore ? -2 : -1,
          providerCancelTime: BigInt(Date.now()),
          cancelReason: reason,
        },
      }),
      this.prisma.order.update({
        where: { id: payment.orderId },
        data: { status: OrderStatus.CANCELLED },
      }),
    ]);
  }
}
