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
import { PAYABLE_ORDER_STATUSES } from '../order-transitions';

/**
 * What a settlement attempt did. Callers (the Payme / Click webhooks) map these
 * onto their protocol replies; nothing but `paid` changed anything.
 *   paid              — THIS call settled the payment and moved the order to PAID
 *   already_paid      — the payment was already PAID (a repeat, or a concurrent
 *                       call won); nothing written, nothing notified
 *   not_settleable    — the payment is in a final non-paid state (cancelled,
 *                       refunded, …); nothing written
 *   order_not_payable — the order left PENDING_PAYMENT (e.g. an operator
 *                       cancelled it); the payment claim was rolled back
 *   not_found         — no such payment
 */
export type MarkPaidOutcome =
  | 'paid'
  | 'already_paid'
  | 'not_settleable'
  | 'order_not_payable'
  | 'not_found';

/** The only payment status a successful provider callback may settle from. */
const SETTLEABLE_PAYMENT_STATUSES: PaymentStatus[] = [PaymentStatus.PENDING];

/** Thrown inside the settlement transaction to roll back the payment claim. */
class OrderNotPayableError extends Error {}

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

  /**
   * Settle a payment and its order — exactly once, even under concurrent
   * callbacks.
   *
   * The payment is CLAIMED with a conditional update (PENDING → PAID) inside
   * the transaction, and the order is moved with a conditional transition
   * (payable → PAID). Both are single guarded UPDATEs, so of two simultaneous
   * Performs only one matches; the other sees `already_paid` and neither writes
   * a second history row nor sends a second notification. If the order is no
   * longer payable (an operator cancelled it, it expired …) the claim is rolled
   * back and NOTHING is written — a payment can never resurrect a CANCELLED
   * order as PAID.
   */
  async markPaid(
    paymentId: string,
    performTimeMs?: number,
  ): Promise<MarkPaidOutcome> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { order: true },
    });
    if (!payment) return 'not_found';
    if (payment.status === PaymentStatus.PAID) return 'already_paid';
    if (!SETTLEABLE_PAYMENT_STATUSES.includes(payment.status)) {
      return 'not_settleable';
    }

    let claimed: boolean;
    try {
      claimed = await this.prisma.$transaction(async (tx) => {
        const claim = await tx.payment.updateMany({
          where: {
            id: paymentId,
            status: { in: SETTLEABLE_PAYMENT_STATUSES },
          },
          data: {
            status: PaymentStatus.PAID,
            paidAt: new Date(),
            providerState: 2,
            providerPerformTime: BigInt(performTimeMs ?? Date.now()),
          },
        });
        if (claim.count === 0) return false; // a concurrent call settled/cancelled it

        const moved = await this.orderStatus.transitionIf(
          payment.orderId,
          PAYABLE_ORDER_STATUSES,
          OrderStatus.PAID,
          { tx, note: 'Payment received' },
        );
        if (!moved) throw new OrderNotPayableError();
        return true;
      });
    } catch (err) {
      if (err instanceof OrderNotPayableError) {
        this.logger.warn(
          `Payment ${paymentId} NOT settled: order ${payment.orderId} is no longer awaiting payment`,
        );
        return 'order_not_payable';
      }
      throw err;
    }

    if (!claimed) {
      const now = await this.prisma.payment.findUnique({
        where: { id: paymentId },
        select: { status: true },
      });
      return now?.status === PaymentStatus.PAID
        ? 'already_paid'
        : 'not_settleable';
    }

    this.logger.log(
      `Order ${payment.orderId} marked PAID via payment ${paymentId}`,
    );

    // Notifications are best-effort and deliberately NON-fatal: the money has
    // been taken and the settlement is committed, so a failing socket or push
    // must not propagate. If it did, PerformTransaction would answer -32400 and
    // Payme would retry a payment that already succeeded. Failures are logged
    // for follow-up instead. Only the call that settled notifies.
    await this.notifyPaid(payment);
    return 'paid';
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
      // Conditional claim (same pattern as markPaid): of two concurrent cancel
      // callbacks only one matches, so the order history gets one row.
      const claim = await tx.payment.updateMany({
        where: {
          id: paymentId,
          status: {
            notIn: [PaymentStatus.CANCELLED, PaymentStatus.REFUNDED],
          },
        },
        data: {
          status: performedBefore
            ? PaymentStatus.REFUNDED
            : PaymentStatus.CANCELLED,
          providerState: performedBefore ? -2 : -1,
          providerCancelTime: BigInt(Date.now()),
          cancelReason: reason,
        },
      });
      if (claim.count === 0) return;
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
