import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PaymentProvider, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PAYME_TRANSACTION_TIMEOUT_MS } from './payme.service';
import { SettlementService } from './settlement.service';

const BATCH = 100;
/** Payme's own "transaction timed out" cancellation reason. */
const TIMEOUT_REASON = 4;
/** Created state on the provider's side. */
const CREATED_STATE = 1;

/**
 * Closes Payme transactions past their 12 hours whose cancel callback never arrived.
 * Until then the order counts as being paid: it cannot expire or be marked paid by
 * hand, and it blocks account deletion.
 *
 * Goes through markCancelled, whose claim moves only a PENDING payment, so a Perform
 * that got in first wins and a repeat sweep changes nothing. No money moved on these,
 * so no refund or receipt of money is recorded, and the order gets the fresh payment
 * window every released order gets, then expires through the usual sweep.
 */
@Injectable()
export class PaymeTransactionSweeper {
  private readonly logger = new Logger(PaymeTransactionSweeper.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settlement: SettlementService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'payme-transaction-sweep', timeZone: 'UTC' })
  async sweep(now: number = Date.now()): Promise<number> {
    const stale = await this.prisma.payment.findMany({
      where: {
        provider: PaymentProvider.PAYME,
        status: PaymentStatus.PENDING,
        providerState: CREATED_STATE,
        providerCreateTime: {
          gt: 0,
          lt: BigInt(now - PAYME_TRANSACTION_TIMEOUT_MS),
        },
      },
      select: { id: true },
      orderBy: [{ providerCreateTime: 'asc' }, { id: 'asc' }],
      take: BATCH,
    });

    let cancelled = 0;
    for (const { id } of stale) {
      try {
        const outcome = await this.settlement.markCancelled(id, TIMEOUT_REASON, false);
        if (outcome === 'cancelled') cancelled += 1;
      } catch (err) {
        this.logger.error(
          `Could not expire Payme payment ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (cancelled > 0) this.logger.log(`Expired ${cancelled} stale Payme transactions`);
    return cancelled;
  }
}
