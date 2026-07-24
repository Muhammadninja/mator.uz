import { Injectable, Logger } from '@nestjs/common';
import { NotificationType, OrderStatus, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { OrderStatusService } from '../order-status.service';

/**
 * Final state transitions shared by the Payme and Click webhooks. Idempotent:
 * marking an already-settled payment is a no-op. Order status changes go through
 * {@link OrderStatusService} so each writes a history row in the same tx.
 */
@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeGateway,
    private readonly orderStatus: OrderStatusService,
  ) {}

  async markPaid(paymentId: string, performTimeMs?: number): Promise<void> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { order: true },
    });
    if (!payment) return;
    if (payment.status === PaymentStatus.PAID) return; // idempotent

    // Flip payment + order (and its history row) atomically; notify after commit.
    await this.prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: PaymentStatus.PAID,
          paidAt: new Date(),
          providerState: 2,
          providerPerformTime: BigInt(performTimeMs ?? Date.now()),
        },
      });
      await this.orderStatus.transition(payment.orderId, OrderStatus.PAID, {
        tx,
        note: 'Payment received',
      });
    });

    // Realtime push to the user's live sockets (frontend `order_paid` event).
    this.realtime.emit(payment.order.userId, {
      type: 'order_paid',
      data: { order_id: payment.orderId, payment_id: payment.id, status: 'paid' },
    });

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
    // Idempotent: a repeated cancel/refund webhook must not write a second
    // CANCELLED history row.
    if (payment.status === PaymentStatus.CANCELLED || payment.status === PaymentStatus.REFUNDED) {
      return;
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: performedBefore ? PaymentStatus.REFUNDED : PaymentStatus.CANCELLED,
          providerState: performedBefore ? -2 : -1,
          providerCancelTime: BigInt(Date.now()),
          cancelReason: reason,
        },
      });
      await this.orderStatus.transition(payment.orderId, OrderStatus.CANCELLED, {
        tx,
        note: performedBefore ? 'Cancelled after refund' : 'Cancelled via payment provider',
      });
    });
  }
}
