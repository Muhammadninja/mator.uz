import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  NotificationType,
  Prisma,
  SourcingOffer,
  SourcingOfferAvailability,
  SourcingOfferCondition,
  SourcingTicketStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { prefixedId, IdPrefix } from '../common/ulid.util';

/**
 * A seller's quote against a sourcing ticket, as captured from the Telegram
 * offer-DM flow. `price` is the only required field — a seller who can't send a
 * photo still files a valid offer, so `images` may be empty.
 */
export interface CreateSourcingOfferInput {
  ticketId: string;
  price: number;
  currency?: string;
  condition?: SourcingOfferCondition;
  availability?: SourcingOfferAvailability;
  etaDays?: number | null;
  note?: string | null;
  images?: string[];
  sellerTgId: string;
  sellerName?: string | null;
  sellerUsername?: string | null;
}

const CONDITION_LABEL: Record<SourcingOfferCondition, string | null> = {
  NEW: 'новый',
  USED: 'б/у',
  OEM: 'оригинал',
  AFTERMARKET: 'аналог',
  UNKNOWN: null,
};

const AVAILABILITY_LABEL: Record<SourcingOfferAvailability, string | null> = {
  IN_STOCK: 'в наличии',
  ON_ORDER: 'под заказ',
  UNKNOWN: null,
};

/**
 * Records seller offers and delivers each one to the requesting customer.
 *
 * Delivery is a SOURCING_OFFER notification (in-app inbox row + push) carrying
 * the price, details and first image, plus a deep link to the offer detail
 * screen. The notification is best-effort: a missing/anonymous ticket owner or
 * a push hiccup NEVER fails offer creation — the offer is the source of truth
 * and an operator can still reach the customer through the ticket console.
 */
@Injectable()
export class SourcingOfferService {
  private readonly logger = new Logger(SourcingOfferService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Persist an offer, move the ticket to OFFERED (without clobbering a terminal
   * state), and notify the customer. Throws NotFoundException when the ticket
   * doesn't exist.
   */
  async createOffer(input: CreateSourcingOfferInput): Promise<SourcingOffer> {
    const ticket = await this.prisma.sourcingTicket.findUnique({
      where: { id: input.ticketId },
    });
    if (!ticket) {
      throw new NotFoundException('Sourcing ticket not found');
    }

    const offer = await this.prisma.sourcingOffer.create({
      data: {
        id: prefixedId(IdPrefix.SOURCING_OFFER),
        ticketId: input.ticketId,
        price: input.price,
        currency: input.currency ?? 'UZS',
        condition: input.condition ?? 'UNKNOWN',
        availability: input.availability ?? 'UNKNOWN',
        etaDays: input.etaDays ?? null,
        note: input.note ?? null,
        images: input.images ?? [],
        sellerTgId: input.sellerTgId,
        sellerName: input.sellerName ?? null,
        sellerUsername: input.sellerUsername ?? null,
      },
    });

    // Advance PENDING/IN_PROGRESS → OFFERED, but never downgrade a ticket the
    // customer has already ACCEPTED or that was CLOSED/CANCELLED.
    await this.prisma.sourcingTicket.updateMany({
      where: {
        id: input.ticketId,
        status: {
          in: [SourcingTicketStatus.PENDING, SourcingTicketStatus.IN_PROGRESS],
        },
      },
      data: { status: SourcingTicketStatus.OFFERED },
    });

    await this.notifyCustomer(ticket.userId, ticket.extractedData, offer);
    return offer;
  }

  /** Offer detail for the owning customer. Null when it isn't theirs / missing. */
  async getOfferForUser(
    offerId: string,
    userId: string,
  ): Promise<(SourcingOffer & { partName: string | null }) | null> {
    const offer = await this.prisma.sourcingOffer.findUnique({
      where: { id: offerId },
      include: { ticket: { select: { userId: true, extractedData: true } } },
    });
    if (!offer || offer.ticket.userId !== userId) return null;
    const { ticket, ...rest } = offer;
    return { ...rest, partName: this.partName(ticket.extractedData) };
  }

  /**
   * Emit the SOURCING_OFFER notification. Guarded end-to-end: only fires for a
   * ticket owned by a real AppUser, and any failure is logged, never thrown, so
   * it can't roll back the committed offer.
   */
  private async notifyCustomer(
    userId: string | null,
    extractedData: Prisma.JsonValue,
    offer: SourcingOffer,
  ): Promise<void> {
    if (!userId) return; // anonymous request — nobody to notify.
    try {
      const owner = await this.prisma.appUser.findUnique({
        where: { id: userId },
        select: { id: true },
      });
      if (!owner) {
        this.logger.debug(
          `Offer ${offer.id}: ticket owner ${userId} is not an AppUser — skipping notification.`,
        );
        return;
      }

      const partName = this.partName(extractedData);
      await this.notifications.emit(userId, {
        type: NotificationType.SOURCING_OFFER,
        title: 'Нашли вашу запчасть 🎉',
        body: this.describe(partName, offer),
        deeplinkPath: `/sourcing/offer/${offer.id}`,
        data: {
          offerId: offer.id,
          ticketId: offer.ticketId,
          partName,
          price: offer.price,
          currency: offer.currency,
          condition: offer.condition,
          availability: offer.availability,
          etaDays: offer.etaDays,
          note: offer.note,
          imageUrl: offer.images[0] ?? null,
          imagesCount: offer.images.length,
          sellerUsername: offer.sellerUsername,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Offer ${offer.id}: notification to ${userId} failed (offer is saved): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** One-line summary: "Тормозные колодки — 250 000 UZS · б/у · в наличии". */
  private describe(partName: string | null, offer: SourcingOffer): string {
    const bits = [
      `${this.formatPrice(offer.price)} ${offer.currency}`,
      CONDITION_LABEL[offer.condition],
      AVAILABILITY_LABEL[offer.availability],
    ].filter((b): b is string => Boolean(b));
    const summary = bits.join(' · ');
    return partName ? `${partName} — ${summary}` : summary;
  }

  private partName(extractedData: Prisma.JsonValue): string | null {
    if (extractedData && typeof extractedData === 'object' && !Array.isArray(extractedData)) {
      const v = (extractedData as Record<string, unknown>).part_name;
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  }

  /** 250000 → "250 000" (thin-space thousands, the market convention). */
  private formatPrice(price: number): string {
    return price.toLocaleString('ru-RU').replace(/ /g, ' ');
  }
}
