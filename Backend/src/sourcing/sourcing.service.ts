import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SourcingTicket, SourcingTicketStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { clampLimit } from '../common/pagination.util';
import { QuerySourcingTicketsDto } from './dto/query-sourcing-tickets.dto';

const MAX_PAGE_SIZE = 100;

export interface CreateSourcingTicketInput {
  /** Optional client-supplied user id (chat is anonymous-capable). */
  userId?: string | null;
  /** The verbatim customer message that triggered the ticket. */
  rawMessage: string;
  /** The LLM's structured extraction (brand/model/year/vin/part_name/preference). */
  extractedData: Record<string, unknown>;
}

/**
 * Persistence for part-sourcing tickets. A ticket is opened by AiChatService
 * when a customer asks for a part that RAG couldn't find in local stock; admins
 * in mator-admin work it through PENDING -> IN_PROGRESS -> OFFERED -> CLOSED.
 */
@Injectable()
export class SourcingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * A still-open (PENDING) ticket for the same part opened within `windowMinutes`
   * — used to de-duplicate rapid repeats so operators don't get N copies of one
   * ask. Scoped to `userId` when it's known; otherwise matches on part alone.
   */
  findRecentDuplicate(input: {
    partName: string;
    userId?: string | null;
    windowMinutes?: number;
  }): Promise<SourcingTicket | null> {
    const since = new Date(Date.now() - (input.windowMinutes ?? 10) * 60_000);
    return this.prisma.sourcingTicket.findFirst({
      where: {
        status: SourcingTicketStatus.PENDING,
        createdAt: { gte: since },
        // jsonb: extracted_data->>'part_name' = partName (exact).
        extractedData: { path: ['part_name'], equals: input.partName },
        ...(input.userId ? { userId: input.userId } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  createTicket(input: CreateSourcingTicketInput): Promise<SourcingTicket> {
    return this.prisma.sourcingTicket.create({
      data: {
        userId: input.userId ?? null,
        rawMessage: input.rawMessage,
        extractedData: input.extractedData as unknown as Prisma.InputJsonValue,
        // status defaults to PENDING at the DB level.
      },
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
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
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
      return await this.prisma.sourcingTicket.update({
        where: { id },
        data: { status },
      });
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
