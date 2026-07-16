import { Injectable } from '@nestjs/common';
import { CatalogSeller } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * "MATOR Certified" dealer storefront (Phase 4C). Read-only over the seeded
 * CatalogSeller rows. Only CURATED dealer rows are returned, identified by the
 * explicit `isCurated` flag (set by the seed for d1–d4). Projected seller_<id>
 * rows from the Telegram pipeline default to `isCurated = false` and are
 * excluded even if they later acquire storefront fields, so this endpoint shows
 * exactly the certified dealers the frontend expects. No hardcoded arrays.
 */
@Injectable()
export class DealersService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    // A curated dealer is identified by the explicit `isCurated` flag — NOT by
    // whether the storefront fields happen to be populated. A projected
    // seller_<id> row that acquires an `initial` must never leak into this list.
    const dealers = await this.prisma.catalogSeller.findMany({
      where: { isCurated: true },
      orderBy: { id: 'asc' },
    });
    return { items: dealers.map(presentDealer) };
  }
}

/** Map a curated CatalogSeller row to the frontend MatorDealer shape. */
export function presentDealer(s: CatalogSeller) {
  return {
    id: s.id,
    name: s.name,
    initial: s.initial ?? '',
    color: s.color ?? '',
    orders: s.orders ?? '',
    years: s.years ?? 0,
  };
}
