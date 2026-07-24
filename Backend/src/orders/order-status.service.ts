import { Injectable } from '@nestjs/common';
import { OrderActorType, OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { prefixedId, IdPrefix } from '../common/ulid.util';

/**
 * The acting user behind a status change — a subset of `req.user` (AppUser).
 * A missing actor is recorded as a SYSTEM transition (webhooks, cron, creation).
 */
export interface TransitionActor {
  id: string;
  role?: string | null;
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
    await tx.orderStatusHistory.create({ data: this.historyData(orderId, status, undefined, note) });
  }

  /**
   * Move a single order to `status` and append the matching history row,
   * atomically. Pass `tx` to enlist in a caller's transaction (e.g. the payment
   * webhook flipping payment + order together); otherwise a transaction is
   * opened here. Callers must guard against no-op transitions (from === to) to
   * avoid duplicate history rows — this writer does not re-read to check.
   */
  async transition(orderId: string, status: OrderStatus, opts: TransitionOptions = {}): Promise<void> {
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
   * Expire every overdue unpaid order (the sweeper cron). Each expiry is applied
   * under a status guard and, only when it actually flips a row, writes one
   * SYSTEM history entry — so a concurrent payment landing between the scan and
   * the write can never produce a phantom "expired" history row. Returns the
   * number of orders expired.
   */
  async expireOverdue(now: Date): Promise<number> {
    const overdue = await this.prisma.order.findMany({
      where: { status: OrderStatus.PENDING_PAYMENT, expiresAt: { lt: now } },
      select: { id: true },
    });

    let expired = 0;
    for (const { id } of overdue) {
      await this.prisma.$transaction(async (tx) => {
        // Conditional flip: only transitions rows still PENDING_PAYMENT, so a row
        // paid since the scan is skipped (count 0) and gets no history entry.
        const res = await tx.order.updateMany({
          where: { id, status: OrderStatus.PENDING_PAYMENT },
          data: { status: OrderStatus.EXPIRED },
        });
        if (res.count === 1) {
          await tx.orderStatusHistory.create({
            data: this.historyData(id, OrderStatus.EXPIRED, undefined, 'Expired: payment window elapsed'),
          });
          expired += 1;
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
    const type = role === 'ADMIN' ? OrderActorType.ADMIN : OrderActorType.OPERATOR;
    const name =
      actor.displayName?.trim() ||
      [actor.firstName, actor.lastName].filter(Boolean).join(' ').trim() ||
      null;
    return { type, id: actor.id, name };
  }
}
