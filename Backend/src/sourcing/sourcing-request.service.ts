import { ConflictException, Injectable } from '@nestjs/common';
import {
  Prisma,
  SourcingRequestStatus,
  SourcingStaffNotifyStatus,
  type SourcingTicket,
} from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SourcingConfig } from './sourcing.config';

const POLL_MS = 500;

export type RequestClaim =
  | { kind: 'owner'; requestId: string; leaseToken: string }
  | { kind: 'replay'; response: unknown };

export interface NewSourcingItem {
  id: string;
  partName: string;
  partKey: string;
  vehicleKey: string;
  vehicleId: string | null;
  extractedData: Record<string, unknown>;
}

/** Another worker took over this request while this one was still running. */
export class SourcingLeaseLostError extends Error {}

/** What a stable request id must keep meaning: the same message for the same car. */
export function sourcingPayloadHash(message: string, vehicleId: string | null, vin?: string) {
  return createHash('sha256')
    .update(JSON.stringify([message.trim(), vehicleId, vin ?? null]))
    .digest('hex');
}

/**
 * Makes one customer request happen once.
 *
 * `(user, key)` is unique, so concurrent retries race on that insert and exactly
 * one becomes the owner. The rest wait for its result. The owner's items and
 * result commit in one transaction, guarded by its lease, so a crash leaves
 * nothing behind and a takeover can't commit twice.
 */
@Injectable()
export class SourcingRequestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: SourcingConfig,
  ) {}

  async claim(input: {
    userId: string;
    idempotencyKey: string;
    payloadHash: string;
    vehicleId: string | null;
  }): Promise<RequestClaim> {
    const deadline = Date.now() + this.config.idempotencyWaitMs;
    for (;;) {
      const leaseToken = randomUUID();
      try {
        const request = await this.prisma.sourcingRequest.create({
          data: { ...input, leaseToken, leaseExpiresAt: this.leaseExpiry() },
        });
        return { kind: 'owner', requestId: request.id, leaseToken };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }

      const existing = await this.prisma.sourcingRequest.findUnique({
        where: {
          userId_idempotencyKey: { userId: input.userId, idempotencyKey: input.idempotencyKey },
        },
      });
      // Released between the insert and this read, so try to claim it again.
      if (!existing) continue;

      if (existing.payloadHash !== input.payloadHash) {
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'This request id was already used for a different request.',
        });
      }
      if (existing.status === SourcingRequestStatus.COMPLETED) {
        return { kind: 'replay', response: existing.response };
      }

      const takenOver = await this.prisma.sourcingRequest.updateMany({
        where: {
          id: existing.id,
          status: SourcingRequestStatus.PROCESSING,
          leaseExpiresAt: { lte: new Date() },
        },
        data: { leaseToken, leaseExpiresAt: this.leaseExpiry() },
      });
      if (takenOver.count === 1) return { kind: 'owner', requestId: existing.id, leaseToken };

      if (Date.now() >= deadline) {
        throw new ConflictException({
          code: 'REQUEST_IN_PROGRESS',
          message: 'This request is still being processed.',
        });
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  /**
   * Atomically store the items and the result. Without a claim (an app that sends
   * no request id) the request gets a generated key, so it still groups its items.
   */
  async commit(input: {
    claim: Extract<RequestClaim, { kind: 'owner' }> | null;
    userId: string;
    payloadHash: string;
    vehicleId: string | null;
    rawMessage: string;
    items: NewSourcingItem[];
    response: unknown;
  }): Promise<SourcingTicket[]> {
    const response = input.response as Prisma.InputJsonValue;
    return this.prisma.$transaction(async (tx) => {
      let requestId: string;
      if (input.claim) {
        const updated = await tx.sourcingRequest.updateMany({
          where: {
            id: input.claim.requestId,
            leaseToken: input.claim.leaseToken,
            status: SourcingRequestStatus.PROCESSING,
          },
          data: {
            status: SourcingRequestStatus.COMPLETED,
            leaseToken: null,
            leaseExpiresAt: null,
            response,
          },
        });
        if (updated.count !== 1) throw new SourcingLeaseLostError();
        requestId = input.claim.requestId;
      } else {
        const created = await tx.sourcingRequest.create({
          data: {
            userId: input.userId,
            idempotencyKey: `auto:${randomUUID()}`,
            payloadHash: input.payloadHash,
            vehicleId: input.vehicleId,
            status: SourcingRequestStatus.COMPLETED,
            response,
          },
        });
        requestId = created.id;
      }

      const now = new Date();
      const tickets: SourcingTicket[] = [];
      for (const item of input.items) {
        tickets.push(
          await tx.sourcingTicket.create({
            data: {
              ...item,
              extractedData: item.extractedData as Prisma.InputJsonValue,
              userId: input.userId,
              requestId,
              rawMessage: input.rawMessage,
              staffNotifyStatus: SourcingStaffNotifyStatus.PENDING,
              staffNotifyNextAt: now,
            },
          }),
        );
      }
      return tickets;
    });
  }

  /** Give up a claim that produced no ticket, so a later attempt runs afresh. */
  async release(claim: Extract<RequestClaim, { kind: 'owner' }>): Promise<void> {
    await this.prisma.sourcingRequest.deleteMany({
      where: {
        id: claim.requestId,
        leaseToken: claim.leaseToken,
        status: SourcingRequestStatus.PROCESSING,
      },
    });
  }

  private leaseExpiry() {
    return new Date(Date.now() + this.config.idempotencyLeaseMs);
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
