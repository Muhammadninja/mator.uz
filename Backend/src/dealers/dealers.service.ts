import { Injectable } from '@nestjs/common';
import { CatalogSeller, DealerStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * "MATOR Certified" dealer storefront (Phase 4C). Read-only over the seeded
 * CatalogSeller rows, and LIVE-DRIVEN by the admin dealer console: a dealer
 * appears here only while it is curated, MATOR Certified, and ACTIVE. So when an
 * operator un-certifies or suspends a dealer in /v1/admin/dealers it drops off
 * this row, and re-certifying brings it back — the buyer-facing "MATOR Certified"
 * section and the console can never disagree. The certified/lowestPrice flags are
 * returned so the app renders each badge from real state, not a fixed default.
 */
@Injectable()
export class DealersService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    // Curated (real storefront, not a projected seller_<id> row) AND currently
    // certified AND active. Un-certifying (certified=false) or suspending
    // (status≠ACTIVE, which also clears certified) removes the dealer from the
    // public row — the whole point of "sync every action".
    const dealers = await this.prisma.catalogSeller.findMany({
      where: {
        isCurated: true,
        certified: true,
        status: DealerStatus.ACTIVE,
      },
      orderBy: { id: 'asc' },
    });
    return { items: dealers.map(presentDealer) };
  }
}

/** Map a curated CatalogSeller row to the frontend MatorDealer shape. Includes
 *  the live badge flags so the app shows MATOR Certified / Lowest Price from real
 *  state rather than a hardcoded default. */
export function presentDealer(s: CatalogSeller) {
  return {
    id: s.id,
    name: s.name,
    initial: s.initial ?? '',
    color: s.color ?? '',
    orders: s.orders ?? '',
    years: s.years ?? 0,
    certified: s.certified,
    lowestPrice: s.lowestPrice,
  };
}
