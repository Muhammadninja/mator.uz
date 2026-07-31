import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  NotificationType,
  OrderStatus,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
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
    private readonly config: ConfigService,
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

    this.logger.log(
      `Order ${payment.orderId} marked PAID via payment ${paymentId}`,
    );

    // Notifications are best-effort and deliberately NON-fatal: the money has
    // been taken and the settlement is committed, so a failing socket or push
    // must not propagate. If it did, PerformTransaction would answer -32400 and
    // Payme would retry a payment that already succeeded. Failures are logged
    // for follow-up instead.
    await this.notifyPaid(payment);
  }

  /**
   * Best-effort "order paid" fan-out. Each channel is isolated so one failing
   * transport cannot suppress the other — or fail the caller.
   */
  private async notifyPaid(payment: {
    id: string;
    orderId: string;
    amountUzs: unknown;
    order: { userId: string };
  }): Promise<void> {
    try {
      // Realtime push to the user's live sockets (frontend `order_paid` event).
      this.realtime.emit(payment.order.userId, {
        type: 'order_paid',
        data: {
          order_id: payment.orderId,
          payment_id: payment.id,
          status: 'paid',
        },
      });
    } catch (err) {
      this.logger.error(
        `Realtime order_paid emit failed for order ${payment.orderId}: ${(err as Error).message}`,
      );
    }

    try {
      await this.notifications.emit(payment.order.userId, {
        type: NotificationType.ORDER_PAID,
        title: "To'lov qabul qilindi",
        body: `${Number(payment.amountUzs).toLocaleString('en-US').replace(/,/g, ' ')} so'mlik buyurtmangiz to'landi.`,
        data: { order_id: payment.orderId, payment_id: payment.id },
        deeplinkPath: '/(tabs)/(cart)/order-confirmation',
      });
    } catch (err) {
      this.logger.error(
        `Paid notification failed for order ${payment.orderId}: ${(err as Error).message}`,
      );
    }
  }

  async markCancelled(
    paymentId: string,
    reason?: number,
    performedBefore = false,
  ): Promise<void> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });
    if (!payment) return;
    // Idempotent: a repeated cancel/refund webhook must not write a second
    // CANCELLED history row.
    if (
      payment.status === PaymentStatus.CANCELLED ||
      payment.status === PaymentStatus.REFUNDED
    ) {
      return;
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: performedBefore
            ? PaymentStatus.REFUNDED
            : PaymentStatus.CANCELLED,
          providerState: performedBefore ? -2 : -1,
          providerCancelTime: BigInt(Date.now()),
          cancelReason: reason,
        },
      });
      if (performedBefore) {
        // The money was already taken, so this is a refund — the order follows
        // into REFUNDED (never CANCELLED, which would lose the fact that a
        // payment was made and reversed).
        await this.orderStatus.transition(
          payment.orderId,
          OrderStatus.REFUNDED,
          {
            tx,
            note: 'Refunded via payment provider',
          },
        );
      } else {
        // Cancelling an UNPERFORMED transaction must not kill the order: the
        // customer never paid, so the order stays payable and they can retry —
        // with Click, or with a fresh Payme transaction. Only the reservation is
        // released.
        await this.releaseOrder(tx, payment.orderId, reason);
      }
    });
  }

  /**
   * Release an order held by a cancelled/timed-out provider transaction.
   *
   * The order is left in PENDING_PAYMENT rather than transitioned, so no status
   * change and no history row are written for something the customer never
   * completed. What DOES change is the payment window: `expiresAt` is in the
   * past by now (our TTL is minutes, Payme's transaction lifetime is 12 hours),
   * and leaving it there would let the sweeper expire the order on its very next
   * pass — the customer would watch it die instead of being able to retry. A
   * fresh window is granted from the moment of release.
   *
   * Guarded on status: an order that moved on (paid by the other provider,
   * cancelled by an operator) is left exactly as it is.
   */
  private async releaseOrder(
    tx: Prisma.TransactionClient,
    orderId: string,
    reason?: number,
  ): Promise<void> {
    const ttlMin = Number(this.config.get<string>('ORDER_TTL_MIN') ?? 30);
    const res = await tx.order.updateMany({
      where: { id: orderId, status: OrderStatus.PENDING_PAYMENT },
      data: { expiresAt: new Date(Date.now() + ttlMin * 60_000) },
    });
    if (res.count) {
      this.logger.log(
        `Order ${orderId} released after provider cancellation (reason ${reason ?? 'n/a'}) — payable for another ${ttlMin}m`,
      );
    }
  }
}
