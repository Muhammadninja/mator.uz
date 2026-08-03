import { Injectable } from '@nestjs/common';
import { Prisma, SourcingTicket } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

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
}
