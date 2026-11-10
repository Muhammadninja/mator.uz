import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  BotLanguage,
  Prisma,
  SellerStatus,
  SellerType,
} from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { SellerEvent, type SellerApprovedEvent } from './seller-events';

/**
 * Every move a seller's status may make.
 *
 *   PENDING  → ACTIVE     approval after review
 *   PENDING  → REJECTED   refusal after review
 *   ACTIVE   → REJECTED   withdrawing an approval
 *
 * REJECTED is final here. A rejected seller is not approved by one call: that
 * would skip the review that rejected them. No status in this table leads back
 * to PENDING, because no review step that does so exists yet.
 */
export const SELLER_STATUS_TRANSITIONS: Readonly<
  Record<SellerStatus, readonly SellerStatus[]>
> = {
  [SellerStatus.PENDING]: [SellerStatus.ACTIVE, SellerStatus.REJECTED],
  [SellerStatus.ACTIVE]: [SellerStatus.REJECTED],
  [SellerStatus.REJECTED]: [],
};

export function canTransitionSeller(
  from: SellerStatus,
  to: SellerStatus,
): boolean {
  return SELLER_STATUS_TRANSITIONS[from].includes(to);
}

@Injectable()
export class SellersService {
  private readonly logger = new Logger(SellersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  findByTgId(tgId: bigint) {
    return this.prisma.seller.findUnique({ where: { tgId } });
  }

  findAll(status?: SellerStatus) {
    return this.prisma.seller.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
    });
  }

  findPending() {
    return this.findAll(SellerStatus.PENDING);
  }

  /**
   * Record the interface language a seller picked in the bot. Keyed on tgId
   * (the identity the bot has) rather than the numeric id, so the caller does
   * not need a prior lookup. The row always exists by the time this is called —
   * /start upserts the seller before the language menu is ever shown.
   */
  async setLanguage(tgId: bigint, lang: BotLanguage) {
    return this.prisma.seller.update({ where: { tgId }, data: { lang } });
  }

  /**
   * The seller for this Telegram account, created as PENDING on first contact.
   * Keyed on the unique `tg_id`, so repeated /start (or a retry after a restart)
   * finds the same row. Two updates of one user arriving at once can both miss
   * and both insert; the loser's unique violation is answered with the row the
   * winner created, so it is never a second seller and never an error.
   */
  async upsertFromBot(tgId: bigint, storeName: string, phone = '') {
    try {
      return await this.createOrFindFromBot(tgId, storeName, phone);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const existing = await this.prisma.seller.findUnique({ where: { tgId } });
        if (existing) return existing;
      }
      throw err;
    }
  }

  private createOrFindFromBot(tgId: bigint, storeName: string, phone: string) {
    return this.prisma.seller.upsert({
      where: { tgId },
      update: {},
      // Stated explicitly (it is also the column default): anyone onboarding
      // through the bot is a TELEGRAM seller, with a tg_id and a phone.
      create: {
        sellerType: SellerType.TELEGRAM,
        tgId,
        storeName,
        phone,
        status: SellerStatus.PENDING,
      },
    });
  }

  /**
   * The single chokepoint for a seller's status. Every approval path goes through
   * here, which is why the "seller approved" event is emitted here rather than at
   * a caller: a new console or script gets the notification for free instead of
   * having to remember to send one.
   *
   * Only a move the transition table allows is written (see
   * {@link SELLER_STATUS_TRANSITIONS}). The seller's row is locked and its status
   * read again inside the transaction, so an approval and a rejection arriving
   * together are decided one after the other: the second sees what the first
   * committed and is judged against that, never against a stale read.
   *
   * Asking for the status the seller already has is an idempotent no-op: nothing
   * is written and nobody is messaged, so an admin's retry or double-click is
   * harmless.
   *
   * The event fires only on a real TRANSITION into ACTIVE. Emission is
   * deliberately AFTER the commit and deliberately not awaited on the delivery
   * side: notifying is a consequence of approval, never a precondition. `emit`
   * is synchronous in EventEmitter2 and the listener owns its own error
   * handling, so a failing notification cannot fail (or slow) the approval.
   *
   * @param actorId the acting administrator, for the log line. This plane is
   * authenticated by a buyer-side `Role.ADMIN` account, which the AdminAudit
   * table cannot reference, so the record of who acted is the application log.
   */
  async updateStatus(id: number, status: SellerStatus, actorId?: string) {
    const { seller, previous } = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM sellers WHERE id = ${id} FOR UPDATE`;
      const current = await tx.seller.findUnique({ where: { id } });
      if (!current) throw new NotFoundException(`Seller #${id} not found`);
      if (current.status === status) {
        return { seller: current, previous: current.status };
      }
      if (!canTransitionSeller(current.status, status)) {
        throw new ConflictException({
          code: 'SELLER_STATUS_TRANSITION_NOT_ALLOWED',
          message: `A seller that is ${current.status} cannot be made ${status}.`,
          details: { from: current.status, to: status },
        });
      }
      const updated = await tx.seller.update({
        where: { id },
        data: { status },
      });
      return { seller: updated, previous: current.status };
    });

    if (previous !== status) {
      this.logger.log(
        `Seller #${id} status ${previous} -> ${status} by ${actorId ?? 'unknown'}`,
      );
    }
    // The approval message goes to the seller's Telegram chat. A BUSINESS
    // seller has no Telegram account (tgId is NULL), so there is no one to
    // message — the status change itself is unaffected.
    if (
      status === SellerStatus.ACTIVE &&
      previous !== SellerStatus.ACTIVE &&
      seller.tgId !== null
    ) {
      const payload: SellerApprovedEvent = {
        sellerId: seller.id,
        tgId: seller.tgId,
      };
      this.events.emit(SellerEvent.APPROVED, payload);
    }
    return seller;
  }
}
