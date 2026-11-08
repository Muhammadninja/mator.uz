import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AdminAuditAction,
  AdminAuditEntity,
  OfflineCollection,
  OrderStatus,
  PaymentStatus,
  PaymentType,
  Prisma,
} from '@prisma/client';
import { AdminAuditService } from '../admin/auth/admin-audit.service';
import { IdPrefix, prefixedId } from '../common/ulid.util';
import { PrismaService } from '../prisma/prisma.service';
import { RecordOfflineCollectionDto } from './dto/record-offline-collection.dto';
import { OFFLINE_PAYMENT_TYPES } from './offline-order.policy';
import { toTiyin } from './service-fee.util';

/** The order is in the buyer's hands or on its way there, and not called off. */
const COLLECTIBLE: OrderStatus[] = [
  OrderStatus.PROCESSING,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
];

export interface CollectionActor {
  id: string;
  email: string;
  name: string;
}

function present(row: OfflineCollection, alreadyRecorded: boolean) {
  return {
    orderId: row.orderId,
    method: row.method.toLowerCase(),
    amountUzs: Number(row.amountUzs),
    reference: row.reference,
    fiscalReference: row.fiscalReference,
    collectedAt: row.collectedAt.toISOString(),
    collectedBy: row.collectedByName,
    alreadyRecorded,
  };
}

/**
 * Records that cash or a terminal payment really reached Mator. The order's status
 * says where the goods are; this record alone says the money arrived, and it is what
 * the finance views and the refund registry count as received.
 *
 * It records money and does not depend on fiscalization: the receipt for a cash or
 * terminal sale is issued outside Mator, and `fiscalReference` is only its number, if
 * the operator enters one.
 */
@Injectable()
export class OfflineCollectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  /** Under the order's row lock, so a repeated request reads the first one's row. */
  async record(
    orderId: string,
    dto: RecordOfflineCollectionDto,
    actor: CollectionActor,
    provenance: { ip?: string; userAgent?: string } = {},
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`;
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: {
          status: true,
          paymentType: true,
          totalUzs: true,
          offlineCollectionRequired: true,
          offlineCollection: true,
          payments: {
            where: {
              status: { in: [PaymentStatus.PAID, PaymentStatus.REFUNDED] },
            },
            select: { id: true },
            take: 1,
          },
        },
      });
      if (!order) throw new NotFoundException('Order not found');

      const matches =
        toTiyin(dto.amountUzs) === toTiyin(Number(order.totalUzs));
      if (order.offlineCollection) {
        if (
          toTiyin(dto.amountUzs) !==
          toTiyin(Number(order.offlineCollection.amountUzs))
        ) {
          throw new ConflictException({
            code: 'COLLECTION_ALREADY_RECORDED',
            message: 'A different amount is already recorded for this order.',
          });
        }
        return present(order.offlineCollection, true);
      }

      const method = order.paymentType;
      if (!method || !OFFLINE_PAYMENT_TYPES.includes(method)) {
        throw new ConflictException({
          code: 'ORDER_NOT_OFFLINE',
          message: 'This order is not paid in cash or by terminal.',
        });
      }
      if (!order.offlineCollectionRequired) {
        throw new ConflictException({
          code: 'COLLECTION_NOT_TRACKED',
          message:
            'This order was placed before collections were recorded, so its money already counts as received.',
        });
      }
      if (order.payments.length > 0) {
        throw new ConflictException({
          code: 'ORDER_PAID_ONLINE',
          message: 'This order was paid through a payment provider.',
        });
      }
      if (!COLLECTIBLE.includes(order.status)) {
        throw new ConflictException({
          code: 'ORDER_NOT_COLLECTIBLE',
          message: `Money cannot be recorded on an order that is ${order.status.toLowerCase()}.`,
        });
      }
      if (!matches) {
        throw new ConflictException({
          code: 'COLLECTION_AMOUNT_MISMATCH',
          message: 'The amount is not the order total.',
          details: { total_uzs: Number(order.totalUzs) },
        });
      }
      const reference = dto.reference?.trim() || null;
      if (method === PaymentType.TERMINAL && !reference) {
        throw new BadRequestException({
          code: 'COLLECTION_REFERENCE_REQUIRED',
          message: 'A terminal payment needs its slip number.',
        });
      }

      const row = await tx.offlineCollection.create({
        data: {
          id: prefixedId(IdPrefix.OFFLINE_COLLECTION),
          orderId,
          method,
          amountUzs: new Prisma.Decimal(dto.amountUzs),
          reference,
          fiscalReference: dto.fiscalReference?.trim() || null,
          note: dto.note?.trim() || null,
          collectedAt: new Date(),
          collectedByAdminId: actor.id,
          collectedByName: actor.name,
        },
      });
      await this.audit.record(
        {
          action: AdminAuditAction.ORDER_PAYMENT_CONFIRMED,
          actor: { id: actor.id, email: actor.email, name: actor.name },
          target: {
            entity: AdminAuditEntity.ORDER,
            id: orderId,
            name: orderId,
          },
          previousValues: { collected: false, paymentType: method },
          newValues: {
            collected: true,
            amountUzs: dto.amountUzs,
            ...(reference ? { reference } : {}),
          },
          reason: row.note,
          ip: provenance.ip,
          userAgent: provenance.userAgent,
        },
        tx,
      );
      return present(row, false);
    });
  }
}
