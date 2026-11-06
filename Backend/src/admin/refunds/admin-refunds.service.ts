import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AdminAuditAction,
  AdminAuditEntity,
  Prisma,
  RefundMethod,
  RefundSource,
} from '@prisma/client';
import { clampLimit } from '../../common/pagination.util';
import { IdPrefix, prefixedId } from '../../common/ulid.util';
import {
  breakdownData,
  readRefundPosition,
  settleRefundPosition,
} from '../../orders/financial-refund.ledger';
import { checkStatedBreakdown } from '../../orders/refund-breakdown';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminAuditService } from '../auth/admin-audit.service';
import { AdminAuditContext } from '../auth/admin-auth.service';
import {
  ADMIN_REFUND_SELECT,
  presentPosition,
  presentRefund,
} from './admin-refunds.presenter';
import {
  ListRefundsQueryDto,
  RecordRefundDto,
  VoidRefundDto,
} from './dto/record-refund.dto';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
/** Clocks differ a little between an operator's machine and this server. */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };

/**
 * The registry of money returned to customers. An entry says that money moved and
 * what proves it. It never changes an order's or a payment's status: REFUNDED stays
 * the provider's word alone, and the console must not be able to claim it.
 *
 * It does clear "refund due" once the entries account for everything the order took,
 * since a refund made outside the provider would otherwise be owed forever.
 *
 * Writes lock the order row first, so two people recording at once cannot both spend
 * the same remaining amount, and the second sees the first one's document number.
 */
@Injectable()
export class AdminRefundsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  async list(query: ListRefundsQueryDto) {
    const page = query.page ?? 1;
    const limit = clampLimit(query.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const state = query.state ?? 'active';

    const where: Prisma.FinancialRefundWhereInput = {
      ...(query.method ? { method: query.method } : {}),
      ...(state === 'active' ? { voidedAt: null } : {}),
      ...(state === 'voided' ? { voidedAt: { not: null } } : {}),
      ...(query.from || query.to
        ? {
            refundedAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [rows, totalItems, totals] = await this.prisma.$transaction([
      this.prisma.financialRefund.findMany({
        where,
        select: ADMIN_REFUND_SELECT,
        // The id makes the order total, so pages neither repeat nor lose a row.
        orderBy: [{ refundedAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.financialRefund.count({ where }),
      // Money that really went back: voided entries never count, whatever is listed.
      this.prisma.financialRefund.aggregate({
        where: { AND: [where, { voidedAt: null }] },
        _sum: { amountUzs: true, serviceFeeUzs: true },
      }),
    ]);

    return {
      success: true,
      data: rows.map(presentRefund),
      meta: {
        page,
        limit,
        totalItems,
        totalPages: Math.ceil(totalItems / limit),
        totalAmount: Number(totals._sum.amountUzs ?? 0),
        totalServiceFee: Number(totals._sum.serviceFeeUzs ?? 0),
      },
    };
  }

  /** One order's entries, and where it stands. Voided ones included: it is history. */
  async forOrder(orderId: string) {
    await this.requireOrder(orderId);
    const [rows, position] = await Promise.all([
      this.prisma.financialRefund.findMany({
        where: { orderId },
        select: ADMIN_REFUND_SELECT,
        orderBy: [{ refundedAt: 'desc' }, { id: 'asc' }],
      }),
      readRefundPosition(this.prisma, orderId),
    ]);
    return {
      success: true,
      data: { ...presentPosition(position), refunds: rows.map(presentRefund) },
    };
  }

  async record(
    orderId: string,
    dto: RecordRefundDto,
    ctx: AdminAuditContext = {},
  ) {
    const refundedAt = dto.refundedAt ? new Date(dto.refundedAt) : new Date();
    if (refundedAt.getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
      throw new BadRequestException({
        code: 'REFUND_DATE_IN_FUTURE',
        message: 'A refund cannot be dated in the future.',
      });
    }
    const amount = new Prisma.Decimal(dto.amountUzs);

    const id = await this.prisma.$transaction(async (tx) => {
      await this.lockOrder(tx, orderId);

      const position = await readRefundPosition(tx, orderId);
      if (position.received.lte(0)) {
        throw new ConflictException({
          code: 'REFUND_NOTHING_RECEIVED',
          message:
            'This order never took any money, so nothing can be returned.',
        });
      }
      if (dto.method === RefundMethod.PROVIDER && !position.paymentId) {
        throw new ConflictException({
          code: 'REFUND_NO_PROVIDER_PAYMENT',
          message:
            'This order has no provider payment. Record how the money really went back.',
        });
      }
      const duplicate = await tx.financialRefund.findFirst({
        where: {
          orderId,
          voidedAt: null,
          reference: { equals: dto.reference, mode: 'insensitive' },
        },
        select: { id: true },
      });
      if (duplicate) {
        throw new ConflictException({
          code: 'REFUND_DUPLICATE_REFERENCE',
          message: 'A refund with this document number is already recorded.',
        });
      }
      if (amount.gt(position.remaining)) {
        throw new ConflictException({
          code: 'REFUND_EXCEEDS_RECEIVED',
          message: `Only ${position.remaining.toFixed(2)} UZS of this order can still be returned.`,
        });
      }
      // What the refund gives back of each kind of money: the fee, delivery and each
      // seller's goods. Stated by the operator wherever it is not plain, so what Mator keeps
      // and what it owes each seller stay true, and no part can go back twice.
      const check = checkStatedBreakdown(position.components, amount, {
        serviceFeeUzs: dto.serviceFeeUzs,
        deliveryUzs: dto.deliveryUzs,
        allocations: dto.allocations,
      });
      if (!check.ok) {
        throw new ConflictException({
          code: check.code,
          message: check.message,
        });
      }
      const { breakdown } = check;

      const created = await tx.financialRefund.create({
        data: {
          id: prefixedId(IdPrefix.FINANCIAL_REFUND),
          orderId,
          paymentId: position.paymentId,
          amountUzs: amount,
          ...breakdownData(breakdown),
          method: dto.method,
          source: RefundSource.MANUAL,
          reference: dto.reference,
          fiscalReference: dto.fiscalReference ?? null,
          reason: dto.reason,
          refundedAt,
          createdById: ctx.actor?.id ?? null,
          createdByEmail: ctx.actor?.email ?? null,
          createdByName: ctx.actor?.name ?? null,
        },
        select: { id: true },
      });
      await settleRefundPosition(tx, orderId);

      await this.audit.record(
        {
          action: AdminAuditAction.REFUND_RECORDED,
          actor: ctx.actor,
          actorLabel: ctx.actorLabel,
          target: {
            entity: AdminAuditEntity.ORDER,
            id: orderId,
            name: orderId,
          },
          newValues: {
            refundId: created.id,
            amountUzs: amount.toFixed(2),
            serviceFeeUzs: breakdown.serviceFeeUzs.toFixed(2),
            deliveryUzs: breakdown.deliveryUzs.toFixed(2),
            allocations: breakdown.allocations.map((a) => ({
              sellerId: a.sellerId,
              amountUzs: a.amountUzs.toFixed(2),
            })),
            ...(dto.fiscalReference
              ? { fiscalReference: dto.fiscalReference }
              : {}),
            method: dto.method,
            reference: dto.reference,
            refundedAt: refundedAt.toISOString(),
          },
          reason: dto.reason,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        tx,
      );
      return created.id;
    }, TX_OPTIONS);

    return this.presentOne(id);
  }

  /**
   * Take back an entry that was wrong. It stays in the registry, marked and with the
   * reason. A refund the provider has confirmed really happened, so it stays.
   */
  async voidEntry(id: string, dto: VoidRefundDto, ctx: AdminAuditContext = {}) {
    const found = await this.prisma.financialRefund.findUnique({
      where: { id },
      select: { orderId: true },
    });
    if (!found) throw new NotFoundException('Refund not found');

    await this.prisma.$transaction(async (tx) => {
      await this.lockOrder(tx, found.orderId);

      const entry = await tx.financialRefund.findUniqueOrThrow({
        where: { id },
        select: {
          amountUzs: true,
          method: true,
          reference: true,
          voidedAt: true,
          providerConfirmedAt: true,
        },
      });
      if (entry.voidedAt) {
        throw new ConflictException({
          code: 'REFUND_ALREADY_VOIDED',
          message: 'This entry has already been voided.',
        });
      }
      if (entry.providerConfirmedAt) {
        throw new ConflictException({
          code: 'REFUND_CONFIRMED_BY_PROVIDER',
          message:
            'The payment provider confirmed this refund, so it cannot be voided.',
        });
      }

      await tx.financialRefund.update({
        where: { id },
        data: {
          voidedAt: new Date(),
          voidedById: ctx.actor?.id ?? null,
          voidedByEmail: ctx.actor?.email ?? null,
          voidReason: dto.reason,
        },
      });
      await settleRefundPosition(tx, found.orderId);

      await this.audit.record(
        {
          action: AdminAuditAction.REFUND_VOIDED,
          actor: ctx.actor,
          actorLabel: ctx.actorLabel,
          target: {
            entity: AdminAuditEntity.ORDER,
            id: found.orderId,
            name: found.orderId,
          },
          previousValues: {
            refundId: id,
            amountUzs: new Prisma.Decimal(entry.amountUzs).toFixed(2),
            method: entry.method,
            reference: entry.reference,
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

  private async presentOne(id: string) {
    const row = await this.prisma.financialRefund.findUniqueOrThrow({
      where: { id },
      select: ADMIN_REFUND_SELECT,
    });
    return { success: true, data: presentRefund(row) };
  }

  private async requireOrder(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true },
    });
    if (!order) throw new NotFoundException('Order not found');
  }

  private async lockOrder(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE`;
    if (rows.length === 0) throw new NotFoundException('Order not found');
  }
}
