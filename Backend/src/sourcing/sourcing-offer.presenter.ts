import { SourcingOffer } from '@prisma/client';

/**
 * Customer-facing view of an offer. Deliberately omits the internal Telegram
 * seller id — only a display username (if any) is exposed for a "contact seller"
 * affordance.
 */
export function presentOffer(offer: SourcingOffer & { partName: string | null }) {
  return {
    id: offer.id,
    ticketId: offer.ticketId,
    partName: offer.partName,
    price: offer.price,
    currency: offer.currency,
    condition: offer.condition,
    availability: offer.availability,
    etaDays: offer.etaDays,
    note: offer.note,
    images: offer.images,
    sellerUsername: offer.sellerUsername,
    status: offer.status,
    declineReason: offer.declineReason,
    createdAt: offer.createdAt,
  };
}
