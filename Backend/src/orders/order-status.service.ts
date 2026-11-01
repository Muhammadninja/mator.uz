import { Injectable } from '@nestjs/common';
import { AdminRole, OrderActorType, OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { prefixedId, IdPrefix } from '../common/ulid.util';
import {
  OFFLINE_PAYMENT_TYPES,
  waitingOfflineOrders,
} from './offline-order.policy';

/**
 * Provider transaction state meaning "created, awaiting confirmation" — Payme
 * state 1 (Click's prepare stage uses the same value). An order carrying one is
 * reserved and must not be expired out from under the provider.
 */
export const ACTIVE_PROVIDER_STATE = 1;

/**
 * The acting user behind a status change — a subset of `req.user` (AppUser).
 * A missing actor is recorded as a SYSTEM transition (webhooks, cron, creation).
 */
export interface TransitionActor {
  id: string;
  role?: string | null;
  /** The operator's console role, which decides what they may confirm. */
  adminRole?: AdminRole | null;
  /** Snapshotted into the audit trail along with the name. */
  email?: string | null;
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

interface TransitionOptions {
  actor?: TransitionActor;
  note?: string | null;
  /** Join an existing transaction; when omitted the write opens its own. */
  tx?: Prisma.TransactionClient;
}

/**
 * The single chokepoint for order status changes. Every path that mutates
 * `order.status` — creation, operator writes, payment webhooks, the expiry cron
 * — goes through here so an {@link OrderStatusHistory} row is ALWAYS written in
 * the same transaction. History is therefore the complete, authoritative record
 * of the FSM: a status can never move without leaving a trail.
 *
 * This service is a low-level writer: it does NOT enforce the allowed-transition
 * state machine (that stays on the operator path in OrdersService, which is the
 * only human-driven entry). Automated callers pass statuses their own business
 * logic already validated; the invariant this service guarantees is the audit
 * row, not the legality of the jump.
 */
@Injectable()
export class OrderStatusService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Append the initial history entry for a freshly created order. Call INSIDE
   * the order-creation transaction (after the order row exists) so creation and
   * its first history row commit together.
   */
  async recordCreation(
    tx: Prisma.TransactionClient,
    orderId: string,
    status: OrderStatus = OrderStatus.PENDING_PAYMENT,
    note = 'Order created',
  ): Promise<void> {
    await tx.orderStatusHistory.create({
      data: this.historyData(orderId, status, undefined, note),
    });
  }

  /**
   * Move a single order to `status` and append the matching history row,
   * atomically. Pass `tx` to enlist in a caller's transaction (e.g. the payment
   * webhook flipping payment + order together); otherwise a transaction is
   * opened here. Callers must guard against no-op transitions (from === to) to
   * avoid duplicate history rows — this writer does not re-read to check.
   */
  async transition(
    orderId: string,
    status: OrderStatus,
    opts: TransitionOptions = {},
  ): Promise<void> {
    const run = async (client: Prisma.TransactionClient) => {
      await client.order.update({ where: { id: orderId }, data: { status } });
      await client.orderStatusHistory.create({
        data: this.historyData(orderId, status, opts.actor, opts.note ?? null),
      });
    };
    if (opts.tx) {
      await run(opts.tx);
    } else {
      await this.prisma.$transaction(run);
    }
  }

  /**
   * Move an order to `status` ONLY if it is still in one of `from`, and append
   * the history row only when it actually moved. A single conditional UPDATE,
   * not a read-then-write: under concurrent writers (a payment webhook and an
   * operator, two Performs, …) the database re-checks the guard after the
   * winner commits, so the loser matches nothing and writes no history.
   *
   * @returns true when this call moved the order, false when it was no longer
   *          in an allowed source status (the caller decides what that means).
   */
  async transitionIf(
    orderId: string,
    from: readonly OrderStatus[],
    status: OrderStatus,
    opts: TransitionOptions = {},
  ): Promise<boolean> {
    const run = async (client: Prisma.TransactionClient) => {
      const moved = await client.order.updateMany({
        where: { id: orderId, status: { in: [...from] } },
        data: { status },
      });
      if (moved.count === 0) return false;
      await client.orderStatusHistory.create({
        data: this.historyData(orderId, status, opts.actor, opts.note ?? null),
      });
      return true;
    };
    return opts.tx ? run(opts.tx) : this.prisma.$transaction(run);
  }

  /**
   * Expire every overdue unpaid order (the sweeper cron). Each expiry is applied
   * under a status guard and, only when it actually flips a row, writes one
   * SYSTEM history entry — so a concurrent payment landing between the scan and
   * the write can never produce a phantom "expired" history row. Returns the
   * number of orders expired.
   */
  async expireOverdue(now: Date): Promise<number> {
    const overdue = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.PENDING_PAYMENT,
        expiresAt: { lt: now },
        // An order with a payment provider transaction still in the "created"
        // state is RESERVED: Payme guarantees the customer 12 hours to confirm
        // it, and expiring the order underneath would leave a live transaction
        // pointing at a dead order (and a PerformTransaction that pays for
        // something already cancelled). Our own 30-minute payment window is
        // therefore suspended for as long as such a transaction exists; when it
        // is performed, cancelled or times out, the order becomes eligible again
        // on a later sweep.
        payments: { none: { providerState: ACTIVE_PROVIDER_STATE } },
        // A cash or terminal order has no payment window to miss: EXPIRED is
        // terminal, so this sweep would destroy a live order nobody has looked at.
        // Its own, longer wait is expireUnconfirmedOffline. Spelled with OR because
        // `notIn` alone is SQL `NOT IN`, which also drops NULL: orders from clients
        // that send no payment_type must still expire.
        OR: [
          { paymentType: null },
          { paymentType: { notIn: OFFLINE_PAYMENT_TYPES } },
        ],
      },
      select: { id: true },
    });

    let expired = 0;
    for (const { id } of overdue) {
      await this.prisma.$transaction(async (tx) => {
        // Conditional flip: only transitions rows still PENDING_PAYMENT and
        // still free of an active provider transaction, so an order that was
        // paid — or that acquired a Payme transaction — between the scan and
        // this write is skipped (count 0) and gets no history entry.
        const res = await tx.order.updateMany({
          where: {
            id,
            status: OrderStatus.PENDING_PAYMENT,
            payments: { none: { providerState: ACTIVE_PROVIDER_STATE } },
          },
          data: { status: OrderStatus.EXPIRED },
        });
        if (res.count === 1) {
          await tx.orderStatusHistory.create({
            data: this.historyData(
              id,
              OrderStatus.EXPIRED,
              undefined,
              'Expired: payment window elapsed',
            ),
          });
          expired += 1;
        }
      });
    }
    return expired;
  }

  /**
   * Close cash and terminal orders no operator confirmed within `timeoutHours`.
   * Guarded like the sweep above, so an order confirmed between the scan and the
   * write is skipped and gets no history entry. Measured from creation, not from
   * `expiresAt`: that is the online payment window, which never applied to these.
   *
   * @returns the orders this call actually expired.
   */
  async expireUnconfirmedOffline(
    now: Date,
    timeoutHours: number,
    limit: number,
  ): Promise<{ id: string; userId: string }[]> {
    const where = {
      ...waitingOfflineOrders(now, timeoutHours),
      payments: { none: { providerState: ACTIVE_PROVIDER_STATE } },
    };
    const overdue = await this.prisma.order.findMany({
      where,
      select: { id: true, userId: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });

    const expired: { id: string; userId: string }[] = [];
    for (const order of overdue) {
      await this.prisma.$transaction(async (tx) => {
        const res = await tx.order.updateMany({
          where: { ...where, id: order.id },
          data: { status: OrderStatus.EXPIRED },
        });
        if (res.count === 1) {
          await tx.orderStatusHistory.create({
            data: this.historyData(
              order.id,
              OrderStatus.EXPIRED,
              undefined,
              `Expired: not confirmed by an operator within ${timeoutHours}h`,
            ),
          });
          expired.push(order);
        }
      });
    }
    return expired;
  }

  /** Build the history row payload, snapshotting the actor (id + name at write time). */
  private historyData(
    orderId: string,
    status: OrderStatus,
    actor: TransitionActor | undefined,
    note: string | null | undefined,
  ): Prisma.OrderStatusHistoryUncheckedCreateInput {
    const resolved = this.resolveActor(actor);
    return {
      id: prefixedId(IdPrefix.ORDER_STATUS_HISTORY),
      orderId,
      status,
      note: note ?? null,
      actorType: resolved.type,
      actorId: resolved.id,
      actorName: resolved.name,
    };
  }

  /**
   * Map an actor onto the stored snapshot. No actor → SYSTEM. ADMIN is the
   * operator role in this system; any other authenticated role falls back to
   * OPERATOR. The display name is snapshotted so the entry stays readable even
   * if the profile later changes or the user is deleted.
   */
  private resolveActor(actor?: TransitionActor): {
    type: OrderActorType;
    id: string | null;
    name: string | null;
  } {
    if (!actor) return { type: OrderActorType.SYSTEM, id: null, name: null };
    const role = (actor.role ?? '').toUpperCase();
    const type =
      role === 'ADMIN' ? OrderActorType.ADMIN : OrderActorType.OPERATOR;
    const name =
      actor.displayName?.trim() ||
      [actor.firstName, actor.lastName].filter(Boolean).join(' ').trim() ||
      null;
    return { type, id: actor.id, name };
  }
}
