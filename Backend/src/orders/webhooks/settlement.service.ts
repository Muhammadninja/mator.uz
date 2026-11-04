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
import { recordProviderRefund } from '../financial-refund.ledger';
import { OrderStatusService } from '../order-status.service';
import {
  PAYABLE_ORDER_STATUSES,
  PROVIDER_REFUNDABLE_ORDER_STATUSES,
} from '../order-transitions';

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

/**
 * What a cancellation attempt did. Callers map these onto their protocol replies;
 * only `cancelled` and `refunded` changed anything.
 *   cancelled         — THIS call moved an unperformed payment PENDING → CANCELLED
 *   refunded          — THIS call moved a performed payment PAID → REFUNDED, with
 *                       the order and the refund registry in the same transaction
 *   already_cancelled — the payment was already cancelled or refunded (a repeat, or
 *                       a concurrent call won); nothing written
 *   paid_meanwhile    — asked to cancel an unperformed payment that is PAID by now:
 *                       a Perform committed after the caller read it. Nothing
 *                       written; the caller decides again, on the refund branch
 *   not_refundable    — the goods were handed over; the claim was rolled back
 *   not_cancellable   — the payment is in no state this branch can leave
 *   not_found         — no such payment
 */
export type MarkCancelledOutcome =
  | 'cancelled'
  | 'refunded'
  | 'already_cancelled'
  | 'paid_meanwhile'
  | 'not_refundable'
  | 'not_cancellable'
  | 'not_found';

/** The only payment status a successful provider callback may settle from. */
const SETTLEABLE_PAYMENT_STATUSES: PaymentStatus[] = [PaymentStatus.PENDING];

/** Payment statuses a cancellation has already reached. */
const CANCELLED_PAYMENT_STATUSES: PaymentStatus[] = [
  PaymentStatus.CANCELLED,
  PaymentStatus.REFUNDED,
];

/** Thrown inside the settlement transaction to roll back the payment claim. */
class OrderNotPayableError extends Error {}

/** Thrown inside the cancellation transaction to roll back the payment claim. */
class OrderNotRefundableError extends Error {}

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

  /**
   * Cancel an unperformed payment, or refund a performed one (`performedBefore`).
   *
   * `performedBefore` is only what the caller read a moment ago, so it is never
   * trusted on its own: each branch claims the payment with a conditional update
   * from the ONE status it may leave (PENDING to cancel, PAID to refund). Of a
   * Perform and a Cancel racing on one row, the database re-checks the guard after
   * the winner commits, so a PAID row can never be overwritten by the cancel branch.
   * A caller that lost that race gets `paid_meanwhile` and asks again on the refund
   * branch. An early read is a shortcut, not the guard: only the UPDATE decides.
   */
  async markCancelled(
    paymentId: string,
    reason?: number,
    performedBefore = false,
  ): Promise<MarkCancelledOutcome> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });
    if (!payment) return 'not_found';
    // Idempotent: a repeated cancel/refund webhook must not write a second
    // CANCELLED history row.
    if (CANCELLED_PAYMENT_STATUSES.includes(payment.status)) {
      return 'already_cancelled';
    }

    let claimed: boolean;
    try {
      claimed = await this.prisma.$transaction(async (tx) => {
        const claim = await tx.payment.updateMany({
          where: {
            id: paymentId,
            status: performedBefore
              ? PaymentStatus.PAID
              : PaymentStatus.PENDING,
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
        if (claim.count === 0) return false;
        if (performedBefore) {
          await this.refundOrder(tx, payment.orderId);
          await recordProviderRefund(tx, payment);
        } else {
          // Cancelling an UNPERFORMED transaction must not kill the order: the
          // customer never paid, so the order stays payable and they can retry —
          // with Click, or with a fresh Payme transaction. Only the reservation is
          // released.
          await this.releaseOrder(tx, payment.orderId, reason);
        }
        return true;
      });
    } catch (err) {
      if (err instanceof OrderNotRefundableError) {
        this.logger.warn(
          `Payment ${paymentId} NOT refunded: order ${payment.orderId} has been handed over`,
        );
        return 'not_refundable';
      }
      throw err;
    }
    if (claimed) return performedBefore ? 'refunded' : 'cancelled';

    const now = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: { status: true },
    });
    if (now && CANCELLED_PAYMENT_STATUSES.includes(now.status)) {
      return 'already_cancelled';
    }
    return now?.status === PaymentStatus.PAID && !performedBefore
      ? 'paid_meanwhile'
      : 'not_cancellable';
  }

  /**
   * The money was already taken, so this is a refund: the order follows into REFUNDED
   * (never CANCELLED, which would lose the fact that a payment was made and reversed).
   * Conditional, so an order shipped meanwhile stops the refund instead of being
   * overwritten. An order already REFUNDED just stays there.
   */
  private async refundOrder(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<void> {
    const moved = await this.orderStatus.transitionIf(
      orderId,
      PROVIDER_REFUNDABLE_ORDER_STATUSES,
      OrderStatus.REFUNDED,
      { tx, note: 'Refunded via payment provider' },
    );
    if (moved) return;
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { status: true },
    });
    if (order?.status !== OrderStatus.REFUNDED) {
      throw new OrderNotRefundableError();
    }
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
