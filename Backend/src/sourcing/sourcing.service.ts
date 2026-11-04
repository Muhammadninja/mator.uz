import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SourcingTicket, SourcingTicketStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { clampLimit } from '../common/pagination.util';
import { QuerySourcingTicketsDto } from './dto/query-sourcing-tickets.dto';
import { noticeForStatus } from './sourcing-notice.copy';

const MAX_PAGE_SIZE = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Persistence for part-sourcing tickets. A ticket is opened by AiChatService
 * when a customer asks for a part that RAG couldn't find in local stock; admins
 * in mator-admin work it through PENDING -> IN_PROGRESS -> OFFERED -> CLOSED.
 */
@Injectable()
export class SourcingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * A customer's still-open ticket for the same part on the same car, so asking
   * again doesn't send staff a second copy. Scoped to the account and vehicle, so
   * different customers or cars never merge.
   */
  findOpenDuplicate(input: {
    userId: string;
    partKey: string;
    vehicleKey: string;
    since: Date;
  }): Promise<SourcingTicket | null> {
    return this.prisma.sourcingTicket.findFirst({
      where: {
        userId: input.userId,
        partKey: input.partKey,
        vehicleKey: input.vehicleKey,
        status: { in: [SourcingTicketStatus.PENDING, SourcingTicketStatus.IN_PROGRESS] },
        createdAt: { gte: input.since },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Paginated ticket list for the mator-admin console, newest first, optionally
   * filtered by status. `limit` is clamped to [1, 100] so the ceiling holds even
   * if a value slips past DTO validation. Returns the standard admin envelope.
   */
  async findAllForAdmin(query: QuerySourcingTicketsDto) {
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const limit = clampLimit(query.limit, 20, MAX_PAGE_SIZE);
    const where: Prisma.SourcingTicketWhereInput = query.status
      ? { status: query.status }
      : {};

    // Count + page in one round trip so total and rows are read consistently.
    const [total, data] = await this.prisma.$transaction([
      this.prisma.sourcingTicket.count({ where }),
      this.prisma.sourcingTicket.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        // Each ticket carries its dealer offers so the operator console can show
        // the live state (SENT = offered, ACCEPTED = bought, DECLINED = rejected).
        // sellerTgId is intentionally omitted (internal).
        include: {
          offers: {
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              price: true,
              currency: true,
              status: true,
              condition: true,
              availability: true,
              etaDays: true,
              note: true,
              images: true,
              sellerName: true,
              sellerUsername: true,
              declineReason: true,
              createdAt: true,
            },
          },
        },
      }),
    ]);

    return {
      success: true,
      data: await this.withCustomerContact(data),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  /**
   * Add the customer's verified contact for staff. This route is the only place it
   * leaves the server: an unverified phone number is left out, since it may not be
   * the customer's.
   */
  private async withCustomerContact<T extends { userId: string | null }>(tickets: T[]) {
    // Old tickets can hold a client-supplied id that isn't a uuid at all.
    const ids = [...new Set(tickets.map((t) => t.userId))].filter(
      (id): id is string => !!id && UUID.test(id),
    );
    const users = ids.length
      ? await this.prisma.appUser.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            displayName: true,
            firstName: true,
            lastName: true,
            phoneE164: true,
            phoneVerified: true,
          },
        })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return tickets.map((ticket) => {
      const user = ticket.userId ? byId.get(ticket.userId) : undefined;
      return {
        ...ticket,
        customer: user
          ? {
              name:
                user.displayName ??
                ([user.firstName, user.lastName].filter(Boolean).join(' ') || null),
              phone: user.phoneVerified ? user.phoneE164 : null,
            }
          : null,
      };
    });
  }

  /**
   * Move a ticket to a new status. Throws NotFoundException when no ticket has
   * the given id (Prisma P2025 on update of a missing row).
   */
  async updateStatus(
    id: string,
    status: SourcingTicketStatus,
  ): Promise<SourcingTicket> {
    try {
      const ticket = await this.prisma.sourcingTicket.update({
        where: { id },
        data: { status },
      });
      // Only tickets from the current flow: older ones may have no reachable owner.
      const notice = ticket.requestId ? noticeForStatus(status) : null;
      return notice
        ? await this.prisma.sourcingTicket.update({
            where: { id },
            data: { customerNotice: notice },
          })
        : ticket;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new NotFoundException('Sourcing ticket not found');
      }
      throw err;
    }
  }

  /**
   * Permanently remove a ticket. Throws NotFoundException when no ticket has the
   * given id (Prisma P2025 on delete of a missing row).
   *
   * The ticket's offers cascade-delete (FK onDelete: Cascade), but the customer's
   * SOURCING_OFFER notifications have no FK to the offer, so they would dangle
   * (tapping one → "offer not found"). We collect the offer ids first and clean
   * their notifications after the delete — best-effort, so a cleanup hiccup never
   * fails the delete.
   */
  async deleteTicket(id: string): Promise<void> {
    const offers = await this.prisma.sourcingOffer.findMany({
      where: { ticketId: id },
      select: { id: true },
    });

    try {
      await this.prisma.sourcingTicket.delete({ where: { id } });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new NotFoundException('Sourcing ticket not found');
      }
      throw err;
    }

    if (offers.length > 0) {
      await this.prisma.notification
        .deleteMany({
          where: {
            type: 'SOURCING_OFFER',
            deeplinkPath: { in: offers.map((o) => `/sourcing/offer/${o.id}`) },
          },
        })
        .catch(() => undefined);
    }
  }
}
