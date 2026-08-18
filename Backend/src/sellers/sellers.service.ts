import { Injectable, NotFoundException } from '@nestjs/common';
import { BotLanguage, SellerStatus } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { SellerEvent, type SellerApprovedEvent } from './seller-events';

@Injectable()
export class SellersService {
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

  async upsertFromBot(tgId: bigint, storeName: string, phone = '') {
    return this.prisma.seller.upsert({
      where: { tgId },
      update: {},
      create: { tgId, storeName, phone, status: SellerStatus.PENDING },
    });
  }

  /**
   * The single chokepoint for a seller's status. Every approval path goes through
   * here, which is why the "seller approved" event is emitted here rather than at
   * a caller: a new console or script gets the notification for free instead of
   * having to remember to send one.
   *
   * The event fires only on a real TRANSITION into ACTIVE (`was !== ACTIVE`), so
   * re-approving an already-active seller — an idempotent admin retry, a
   * double-click — does not message them again.
   *
   * Emission is deliberately AFTER the write and deliberately not awaited on the
   * delivery side: notifying is a consequence of approval, never a precondition.
   * `emit` is synchronous in EventEmitter2 and the listener owns its own error
   * handling, so a failing notification cannot fail (or slow) the approval.
   */
  async updateStatus(id: number, status: SellerStatus) {
    const seller = await this.prisma.seller.findUnique({ where: { id } });
    if (!seller) throw new NotFoundException(`Seller #${id} not found`);
    const updated = await this.prisma.seller.update({
      where: { id },
      data: { status },
    });

    if (
      status === SellerStatus.ACTIVE &&
      seller.status !== SellerStatus.ACTIVE
    ) {
      const payload: SellerApprovedEvent = {
        sellerId: updated.id,
        tgId: updated.tgId,
      };
      this.events.emit(SellerEvent.APPROVED, payload);
    }
    return updated;
  }
}
