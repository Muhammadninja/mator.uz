import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AdminAuditAction, AdminAuditEntity, Prisma } from '@prisma/client';
import { IdPrefix, prefixedId } from '../../common/ulid.util';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminAuditService } from '../auth/admin-audit.service';
import { AdminAuditContext } from '../auth/admin-auth.service';
import { PAYOUT_SELECT, presentPayout } from './admin-finance.presenter';
import {
  PayoutHoldDto,
  RecordPayoutDto,
  VoidPayoutDto,
} from './dto/payout.dto';
import { PAYABLE_ORDER, TOOK_MONEY, sellerBalances } from './seller-ledger';

/** Clocks differ a little between an operator's machine and this server. */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };
const ZERO = new Prisma.Decimal(0);
const n = (value: Prisma.Decimal | null | undefined) => Number(value ?? 0);

/**
 * The seller ledger: what each seller is owed and has been paid, what Mator keeps, and the
 * payouts and holds that move it. The arithmetic is in seller-ledger.ts.
 *
 * Mator's commission is each seller's own, as their contract states, frozen on the order's lines
 * when it was placed; a seller with none configured is charged 0%. There is no global rate.
 *
 * A seller is paid only for orders the buyer has, that took the money, and that have no
 * cancellation or return under way. A payout is capped at what is payable less what was already
 * sent, so the same money cannot be sent twice, and a refund after a payout becomes a debt that
 * later earnings pay off first.
 */
@Injectable()
export class AdminFinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  /** Every seller with money on the books, and Mator's own figures beside them. */
  async sellers() {
    const [balances, orders, commission, refunds, commissionBack] =
      await Promise.all([
        sellerBalances(this.prisma),
        this.prisma.order.aggregate({
          where: TOOK_MONEY,
          _sum: { totalUzs: true, serviceFeeUzs: true, deliveryUzs: true },
        }),
        this.prisma.orderItem.aggregate({
          where: { order: TOOK_MONEY },
          _sum: { commissionUzs: true },
        }),
        this.prisma.financialRefund.aggregate({
          where: { voidedAt: null },
          _sum: { amountUzs: true, serviceFeeUzs: true, deliveryUzs: true },
        }),
        this.prisma.financialRefundAllocation.aggregate({
          where: { refund: { voidedAt: null } },
          _sum: { commissionUzs: true },
        }),
      ]);
    return {
      success: true,
      data: balances,
      meta: {
        paidByBuyers: n(orders._sum.totalUzs),
        refundedToBuyers: n(refunds._sum.amountUzs),
        matorServiceFee:
          n(orders._sum.serviceFeeUzs) - n(refunds._sum.serviceFeeUzs),
        matorCommission:
          n(commission._sum.commissionUzs) -
          n(commissionBack._sum.commissionUzs),
        delivery: n(orders._sum.deliveryUzs) - n(refunds._sum.deliveryUzs),
      },
    };
  }

  /** One seller: the balance, each order it comes from, and every payout. */
  async seller(sellerId: string) {
    const [balances, lines, allocations, payouts, payableOrders] =
      await Promise.all([
        sellerBalances(this.prisma, sellerId),
        this.prisma.orderItem.findMany({
          where: { sellerId, order: TOOK_MONEY },
          select: {
            orderId: true,
            lineTotalUzs: true,
            commissionPercent: true,
            commissionUzs: true,
            order: {
              select: { status: true, createdAt: true, payoutHoldReason: true },
            },
          },
          orderBy: { orderId: 'desc' },
        }),
        this.prisma.financialRefundAllocation.findMany({
          where: { sellerId, refund: { voidedAt: null } },
          select: {
            amountUzs: true,
            commissionUzs: true,
            refund: { select: { orderId: true } },
          },
        }),
        this.prisma.sellerPayout.findMany({
          where: { sellerId },
          select: PAYOUT_SELECT,
          orderBy: [{ paidAt: 'desc' }, { id: 'asc' }],
        }),
        this.prisma.order.findMany({
          where: { ...PAYABLE_ORDER, items: { some: { sellerId } } },
          select: { id: true },
        }),
      ]);
    const balance = balances.find((b) => b.sellerId === sellerId);
    if (!balance && payouts.length === 0) {
      throw new NotFoundException('No money is recorded for this seller');
    }

    type Row = {
      status: string;
      createdAt: Date;
      holdReason: string | null;
      commissionPercent: Prisma.Decimal;
      sold: Prisma.Decimal;
      commission: Prisma.Decimal;
      refunded: Prisma.Decimal;
      commissionBack: Prisma.Decimal;
    };
    const orders = new Map<string, Row>();
    for (const line of lines) {
      const row = orders.get(line.orderId) ?? {
        status: line.order.status,
        createdAt: line.order.createdAt,
        holdReason: line.order.payoutHoldReason,
        commissionPercent: line.commissionPercent,
        sold: ZERO,
        commission: ZERO,
        refunded: ZERO,
        commissionBack: ZERO,
      };
      row.sold = row.sold.add(line.lineTotalUzs);
      row.commission = row.commission.add(line.commissionUzs);
      orders.set(line.orderId, row);
    }
    for (const allocation of allocations) {
      const row = orders.get(allocation.refund.orderId);
      if (!row) continue;
      row.refunded = row.refunded.add(allocation.amountUzs);
      row.commissionBack = row.commissionBack.add(allocation.commissionUzs);
    }
    const payable = new Set(payableOrders.map((o) => o.id));

    return {
      success: true,
      data: {
        balance: balance ?? null,
        orders: [...orders].map(([orderId, row]) => ({
          orderId,
          status: row.status.toLowerCase(),
          createdAt: row.createdAt.toISOString(),
          payable: payable.has(orderId),
          payoutHold: row.holdReason,
          commissionPercent: Number(row.commissionPercent),
          sold: Number(row.sold),
          refunded: Number(row.refunded),
          commission: Number(row.commission.sub(row.commissionBack)),
          net: Number(
            row.sold
              .sub(row.refunded)
              .sub(row.commission.sub(row.commissionBack)),
          ),
        })),
        payouts: payouts.map(presentPayout),
      },
    };
  }

  /**
   * Record money sent to a seller. Under a lock on the seller's row, so two people recording at
   * once cannot both spend what is payable, and the second sees the first's document number.
   */
  async recordPayout(
    sellerId: string,
    dto: RecordPayoutDto,
    ctx: AdminAuditContext = {},
  ) {
    const paidAt = dto.paidAt ? new Date(dto.paidAt) : new Date();
    if (paidAt.getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
      throw new BadRequestException({
        code: 'PAYOUT_DATE_IN_FUTURE',
        message: 'A payout cannot be dated in the future.',
      });
    }
    const amount = new Prisma.Decimal(dto.amountUzs);

    const id = await this.prisma.$transaction(async (tx) => {
      const seller = await this.lockSeller(tx, sellerId);
      const duplicate = await tx.sellerPayout.findFirst({
        where: {
          sellerId,
          voidedAt: null,
          reference: { equals: dto.reference, mode: 'insensitive' },
        },
        select: { id: true },
      });
      if (duplicate) {
        throw new ConflictException({
          code: 'PAYOUT_DUPLICATE_REFERENCE',
          message: 'A payout with this document number is already recorded.',
        });
      }
      const balance = (await sellerBalances(tx, sellerId)).find(
        (b) => b.sellerId === sellerId,
      );
      const payable = new Prisma.Decimal(balance?.payableNowUzs ?? 0);
      if (amount.gt(payable)) {
        throw new ConflictException({
          code: 'PAYOUT_EXCEEDS_OWED',
          message: `Only ${payable.toFixed(2)} UZS can be paid to this seller now: delivered, paid orders with nothing under way, less what was already sent.`,
        });
      }

      const created = await tx.sellerPayout.create({
        data: {
          id: prefixedId(IdPrefix.SELLER_PAYOUT),
          sellerId,
          amountUzs: amount,
          method: dto.method,
          reference: dto.reference,
          note: dto.note ?? null,
          paidAt,
          createdById: ctx.actor?.id ?? null,
          createdByEmail: ctx.actor?.email ?? null,
          createdByName: ctx.actor?.name ?? null,
        },
        select: { id: true },
      });
      await this.audit.record(
        {
          action: AdminAuditAction.SELLER_PAYOUT_RECORDED,
          actor: ctx.actor,
          actorLabel: ctx.actorLabel,
          target: {
            entity: AdminAuditEntity.DEALER,
            id: sellerId,
            name: seller.name,
          },
          newValues: {
            payoutId: created.id,
            amountUzs: amount.toFixed(2),
            method: dto.method,
            reference: dto.reference,
            paidAt: paidAt.toISOString(),
          },
          reason: dto.note ?? null,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        tx,
      );
      return created.id;
    }, TX_OPTIONS);

    return this.presentOne(id);
  }

  /** Take back a wrong payout entry. It stays on record, marked, with the reason. */
  async voidPayout(
    id: string,
    dto: VoidPayoutDto,
    ctx: AdminAuditContext = {},
  ) {
    const found = await this.prisma.sellerPayout.findUnique({
      where: { id },
      select: { sellerId: true },
    });
    if (!found) throw new NotFoundException('Payout not found');

    await this.prisma.$transaction(async (tx) => {
      const seller = await this.lockSeller(tx, found.sellerId);
      const payout = await tx.sellerPayout.findUniqueOrThrow({
        where: { id },
        select: {
          amountUzs: true,
          method: true,
          reference: true,
          voidedAt: true,
        },
      });
      if (payout.voidedAt) {
        throw new ConflictException({
          code: 'PAYOUT_ALREADY_VOIDED',
          message: 'This payout has already been voided.',
        });
      }
      await tx.sellerPayout.update({
        where: { id },
        data: {
          voidedAt: new Date(),
          voidedById: ctx.actor?.id ?? null,
          voidedByEmail: ctx.actor?.email ?? null,
          voidReason: dto.reason,
        },
      });
      await this.audit.record(
        {
          action: AdminAuditAction.SELLER_PAYOUT_VOIDED,
          actor: ctx.actor,
          actorLabel: ctx.actorLabel,
          target: {
            entity: AdminAuditEntity.DEALER,
            id: found.sellerId,
            name: seller.name,
          },
          previousValues: {
            payoutId: id,
            amountUzs: new Prisma.Decimal(payout.amountUzs).toFixed(2),
            method: payout.method,
            reference: payout.reference,
          },
          reason: dto.reason,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        tx,
      );
    }, TX_OPTIONS);

    return this.presentOne(id);
  }

  /**
   * Hold an order back from seller payouts while a cancellation or return is under way, or
   * release it once that is settled. Conditional, so a repeat changes nothing and leaves no
   * second audit entry.
   */
  async setPayoutHold(
    orderId: string,
    hold: boolean,
    dto: PayoutHoldDto,
    ctx: AdminAuditContext = {},
  ) {
    const changed = await this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: { payoutHoldAt: true, payoutHoldReason: true },
      });
      if (!order) throw new NotFoundException('Order not found');
      const res = await tx.order.updateMany({
        where: {
          id: orderId,
          payoutHoldAt: hold ? null : { not: null },
        },
        data: hold
          ? { payoutHoldAt: new Date(), payoutHoldReason: dto.reason }
          : { payoutHoldAt: null, payoutHoldReason: null },
      });
      if (res.count === 0) return false;
      await this.audit.record(
        {
          action: hold
            ? AdminAuditAction.ORDER_PAYOUT_HOLD_SET
            : AdminAuditAction.ORDER_PAYOUT_HOLD_RELEASED,
          actor: ctx.actor,
          actorLabel: ctx.actorLabel,
          target: {
            entity: AdminAuditEntity.ORDER,
            id: orderId,
            name: orderId,
          },
          previousValues: { payoutHold: order.payoutHoldReason },
          newValues: { payoutHold: hold ? dto.reason : null },
          reason: dto.reason,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        tx,
      );
      return true;
    }, TX_OPTIONS);

    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { payoutHoldAt: true, payoutHoldReason: true },
    });
    return {
      success: true,
      data: {
        orderId,
        changed,
        payoutHoldAt: order.payoutHoldAt?.toISOString() ?? null,
        payoutHoldReason: order.payoutHoldReason,
      },
    };
  }

  private async lockSeller(tx: Prisma.TransactionClient, sellerId: string) {
    const rows = await tx.$queryRaw<{ id: string; name: string }[]>`
      SELECT "id", "name" FROM "catalog_sellers" WHERE "id" = ${sellerId} FOR UPDATE`;
    if (rows.length === 0) throw new NotFoundException('Seller not found');
    return rows[0];
  }

  private async presentOne(id: string) {
    const row = await this.prisma.sellerPayout.findUniqueOrThrow({
      where: { id },
      select: PAYOUT_SELECT,
    });
    return { success: true, data: presentPayout(row) };
  }
}
