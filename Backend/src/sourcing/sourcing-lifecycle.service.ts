import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  NotificationType,
  SourcingOfferStatus,
  SourcingRequestStatus,
  SourcingStaffNotifyStatus,
  SourcingTicketStatus,
} from '@prisma/client';
import { AdminEventsGateway } from '../events/admin-events.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramNotifierService } from '../telegram/telegram-notifier.service';
import { sourcingNoticeCopy, type SourcingNotice } from './sourcing-notice.copy';
import { SourcingOfferService } from './sourcing-offer.service';
import { SourcingConfig } from './sourcing.config';

const BATCH = 25;
const OPEN_STATUSES = [SourcingTicketStatus.PENDING, SourcingTicketStatus.IN_PROGRESS];
/** Long enough that a slow send isn't picked up again by the next sweep. */
const SEND_CLAIM_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const ORPHAN_CLAIM_MS = 60 * 60_000;

/**
 * Everything a sourcing request owes after the chat reply: staff delivery with
 * retries, escalation, no-offer outcomes, offer expiry and customer updates.
 *
 * Database-backed, so work survives a restart. Every query filters on a column
 * only the new flow sets (`requestId`, `staffNotifyStatus`, `expiresAt`,
 * `customerNotice`, `customerNotifyPending`): tickets and offers from before
 * this release are never re-sent, expired or closed.
 */
@Injectable()
export class SourcingLifecycleService {
  private readonly logger = new Logger(SourcingLifecycleService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: SourcingConfig,
    private readonly telegram: TelegramNotifierService,
    private readonly adminEvents: AdminEventsGateway,
    private readonly notifications: NotificationsService,
    private readonly offers: SourcingOfferService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'sourcing-lifecycle', timeZone: 'UTC' })
  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      // One failing step must not hold up the others.
      for (const step of [
        () => this.retryStaffNotifications(now),
        () => this.escalateUnattended(now),
        () => this.closeWithoutOffers(now),
        () => this.expireOffers(now),
        () => this.deliverOfferNotifications(),
        () => this.deliverCustomerNotices(),
        () => this.removeAbandonedClaims(now),
      ]) {
        await step().catch((err: unknown) =>
          this.logger.error(`Sourcing sweep step failed: ${errorText(err)}`),
        );
      }
    } finally {
      this.running = false;
    }
  }

  private async retryStaffNotifications(now: Date): Promise<void> {
    const due = await this.prisma.sourcingTicket.findMany({
      where: {
        staffNotifyStatus: SourcingStaffNotifyStatus.PENDING,
        staffNotifyNextAt: { lte: now },
      },
      select: { id: true },
      take: BATCH,
    });
    for (const { id } of due) await this.dispatchStaffNotification(id);
  }

  /**
   * Send one ticket to staff. The claim pushes the next attempt into the future
   * first, so overlapping runs don't both send. A crash after sending but before
   * recording can repeat one message, which beats losing it.
   */
  async dispatchStaffNotification(ticketId: string): Promise<void> {
    const now = new Date();
    const claimed = await this.prisma.sourcingTicket.updateMany({
      where: {
        id: ticketId,
        staffNotifyStatus: SourcingStaffNotifyStatus.PENDING,
        staffNotifyNextAt: { lte: now },
      },
      data: {
        staffNotifyNextAt: new Date(now.getTime() + SEND_CLAIM_MS),
        staffNotifyAttempts: { increment: 1 },
      },
    });
    if (claimed.count === 0) return;

    const ticket = await this.prisma.sourcingTicket.findUnique({ where: { id: ticketId } });
    if (!ticket) return;

    const result = await this.telegram.sendSourcingTicketToDealers(ticket);
    if (result.ok) {
      await this.prisma.sourcingTicket.update({
        where: { id: ticketId },
        data: {
          staffNotifyStatus: SourcingStaffNotifyStatus.SENT,
          staffNotifiedAt: new Date(),
          staffNotifyNextAt: null,
          staffNotifyError: null,
        },
      });
      return;
    }

    const exhausted = ticket.staffNotifyAttempts >= this.config.staffNotifyMaxAttempts;
    await this.prisma.sourcingTicket.update({
      where: { id: ticketId },
      data: exhausted
        ? {
            staffNotifyStatus: SourcingStaffNotifyStatus.FAILED,
            staffNotifyNextAt: null,
            staffNotifyError: result.error,
          }
        : {
            staffNotifyNextAt: new Date(Date.now() + backoffMs(ticket.staffNotifyAttempts)),
            staffNotifyError: result.error,
          },
    });
    if (exhausted) {
      this.logger.error(`Sourcing ticket ${ticketId} failed staff delivery: ${result.error}`);
    }
  }

  /** Tickets nobody has picked up, or that never reached staff at all. */
  private async escalateUnattended(now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - this.config.escalateAfterMs);
    const tickets = await this.prisma.sourcingTicket.findMany({
      where: {
        requestId: { not: null },
        escalatedAt: null,
        status: SourcingTicketStatus.PENDING,
        OR: [
          { createdAt: { lte: cutoff } },
          { staffNotifyStatus: SourcingStaffNotifyStatus.FAILED },
        ],
      },
      take: BATCH,
    });
    for (const ticket of tickets) {
      const result = await this.telegram.sendSourcingEscalation(ticket);
      this.adminEvents.notifyAdminsTicketEscalated(ticket);
      // Without an escalation chat the console event still went out, so this
      // doesn't retry forever. A failed send does retry on the next sweep.
      if (result.ok || !this.telegram.escalationConfigured) {
        await this.prisma.sourcingTicket.update({
          where: { id: ticket.id },
          data: { escalatedAt: new Date() },
        });
      }
    }
  }

  private async closeWithoutOffers(now: Date): Promise<void> {
    const result = await this.prisma.sourcingTicket.updateMany({
      where: {
        requestId: { not: null },
        status: { in: OPEN_STATUSES },
        createdAt: { lte: new Date(now.getTime() - this.config.noOfferAfterMs) },
        offers: { none: {} },
      },
      data: { status: SourcingTicketStatus.NO_OFFER, customerNotice: 'NO_OFFER' },
    });
    if (result.count) this.logger.log(`${result.count} sourcing tickets ended with no offer`);
  }

  private async expireOffers(now: Date): Promise<void> {
    const expired = await this.prisma.sourcingOffer.findMany({
      where: { status: SourcingOfferStatus.SENT, expiresAt: { lte: now } },
      select: { id: true, ticketId: true },
      take: BATCH,
    });
    for (const offer of expired) {
      const flip = await this.prisma.sourcingOffer.updateMany({
        where: { id: offer.id, status: SourcingOfferStatus.SENT },
        data: { status: SourcingOfferStatus.EXPIRED, customerNotifyPending: false },
      });
      if (flip.count === 0) continue;
      // Only when this was the ticket's last live offer: others can still be bought.
      const live = await this.prisma.sourcingOffer.count({
        where: { ticketId: offer.ticketId, status: SourcingOfferStatus.SENT },
      });
      if (live === 0) {
        await this.prisma.sourcingTicket.updateMany({
          where: {
            id: offer.ticketId,
            requestId: { not: null },
            status: SourcingTicketStatus.OFFERED,
          },
          data: { status: SourcingTicketStatus.NO_OFFER, customerNotice: 'OFFERS_EXPIRED' },
        });
      }
    }
  }

  private async deliverOfferNotifications(): Promise<void> {
    const pending = await this.prisma.sourcingOffer.findMany({
      where: { customerNotifyPending: true, status: SourcingOfferStatus.SENT },
      select: { id: true },
      take: BATCH,
    });
    for (const { id } of pending) await this.offers.deliverOfferNotification(id);
  }

  private async deliverCustomerNotices(): Promise<void> {
    const tickets = await this.prisma.sourcingTicket.findMany({
      where: { customerNotice: { not: null } },
      take: BATCH,
    });
    for (const ticket of tickets) {
      const notice = ticket.customerNotice as SourcingNotice;
      const claimed = await this.prisma.sourcingTicket.updateMany({
        where: { id: ticket.id, customerNotice: notice },
        data: { customerNotice: null },
      });
      if (claimed.count === 0 || !ticket.userId) continue;

      try {
        const owner = await this.prisma.appUser.findUnique({
          where: { id: ticket.userId },
          select: { language: true },
        });
        if (!owner) continue;
        await this.notifications.emit(ticket.userId, {
          type: NotificationType.SOURCING_STATUS,
          ...sourcingNoticeCopy(notice, owner.language, ticket.partName ?? ''),
          data: { kind: notice, ticketId: ticket.id, partName: ticket.partName },
        });
      } catch (err) {
        await this.prisma.sourcingTicket.updateMany({
          where: { id: ticket.id, customerNotice: null },
          data: { customerNotice: notice },
        });
        this.logger.warn(`Notice for ticket ${ticket.id} will retry: ${errorText(err)}`);
      }
    }
  }

  /** A claim whose process died without ever producing a ticket. */
  private async removeAbandonedClaims(now: Date): Promise<void> {
    await this.prisma.sourcingRequest.deleteMany({
      where: {
        status: SourcingRequestStatus.PROCESSING,
        leaseExpiresAt: { lte: new Date(now.getTime() - ORPHAN_CLAIM_MS) },
      },
    });
  }
}

function backoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
