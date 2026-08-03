import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { formatUzs } from '../catalog/parts/part.presenter';

/** A matched in-stock part returned to the chat client. */
export interface StockItem {
  id: string;
  title: string;
  /** Display-formatted retail price ("250 000 сум"). */
  price: string;
  category: string | null;
}

export interface RagSearchResult {
  found: boolean;
  items: StockItem[];
}

/** What the sourcing chat can search on (a subset of the LLM extraction). */
export interface RagQuery {
  partName: string | null;
  brand: string | null;
  model: string | null;
}

const MAX_ITEMS = 8;

/**
 * Retrieval over the buyer-facing `catalog_parts` projection — the same
 * read-model the catalog SearchService queries. Deliberately basic: it matches
 * the requested part name against the listing title and returns only in-stock
 * rows.
 *
 * NOTE: lives directly under `ai-chat/` (not an `ai-chat/services/` subfolder)
 * because the repo's .gitignore has a blanket `services/` rule that would make
 * the file untrackable.
 *
 * NOTE: `brand`/`model` here are the *vehicle* (e.g. Skoda / Kodiaq), whereas
 * `CatalogPart.brandId` is the *part* brand (e.g. Bosch). Precise vehicle
 * fitment lives in the PartModel -> CarModel join, not on this projection, so
 * this basic pass keys on part name only; wiring vehicle-fitment scoping is a
 * follow-up rather than a wrong filter here.
 */
@Injectable()
export class RagSearchService {
  constructor(private readonly prisma: PrismaService) {}

  async searchInStock(query: RagQuery): Promise<RagSearchResult> {
    const term = query.partName?.trim();
    if (!term) return { found: false, items: [] };

    const rows = await this.prisma.catalogPart.findMany({
      where: {
        inStock: true,
        title: { contains: term, mode: 'insensitive' },
      },
      include: { category: true },
      orderBy: { priceUzs: 'asc' },
      take: MAX_ITEMS,
    });

    const items: StockItem[] = rows.map((row) => ({
      id: row.id,
      title: row.title,
      price: formatUzs(row.priceUzs),
      category: row.category?.name ?? null,
    }));

    return { found: items.length > 0, items };
  }
}
