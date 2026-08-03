import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { formatUzs } from '../catalog/parts/part.presenter';
import { ActiveSale, DiscountService } from '../sales/discount.service';
import { expandToken } from './part-synonyms.util';

/** A matched in-stock part returned to the chat client. */
export interface StockItem {
  id: string;
  title: string;
  /** Display-formatted retail price ("250 000 сум") — sale-adjusted. */
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
const CANDIDATE_LIMIT = 60;

// Connector/filler words that carry no matching signal, across the languages the
// chat sees (RU / UZ-Latin / EN). NOTE: real part words (oil, moy, …) are NOT
// here — they carry signal and are expanded via the synonym map.
const STOP_WORDS = new Set([
  'для', 'на', 'нужен', 'нужна', 'нужно', 'ищу', 'мне', 'есть', 'хочу',
  'kerak', 'uchun', 'menga', 'bor', 'izlayapman', 'have', 'need', 'want',
  'the', 'for', 'and', 'you', 'your', 'give',
]);

/**
 * Retrieval over the buyer-facing `catalog_parts` projection.
 *
 * The extracted part phrase almost never equals a substring of the real title
 * ("Shell Helix HX7 5W-30" vs a request for "масло Shell 5w-30"), AND customers
 * write in a different language than the (Russian) titles. So a single
 * `title LIKE %phrase%` misses everything. Instead we TOKENISE the phrase,
 * EXPAND each token to its cross-language synonyms ({@link expandToken}), match
 * any form against the title OR the brand name, then RANK candidates by how many
 * distinct query tokens hit — biased toward recall (an under-find wrongly opens a
 * ticket, which is worse than showing a few options).
 *
 * Prices are sale-adjusted via {@link DiscountService} so the chat quotes the
 * SAME price the catalog and cart charge (never the pre-sale price).
 *
 * NOTE: this is application-side ranking, fine for the small catalog. For typo
 * tolerance + relevance at scale, move to Postgres `pg_trgm` (GIN index on
 * title + brand) — see the AI-sourcing follow-ups.
 */
@Injectable()
export class RagSearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly discounts: DiscountService,
  ) {}

  async searchInStock(query: RagQuery): Promise<RagSearchResult> {
    const tokens = this.tokenize(query.partName);
    if (tokens.length === 0) return { found: false, items: [] };

    // Each token → all its cross-language search forms.
    const expandedByToken = tokens.map((t) => expandToken(t));
    const allForms = Array.from(new Set(expandedByToken.flat()));

    // In-stock parts matching ANY search form in the title or the brand name.
    const or: Prisma.CatalogPartWhereInput[] = allForms.flatMap((f) => [
      { title: { contains: f, mode: 'insensitive' } },
      { brand: { is: { name: { contains: f, mode: 'insensitive' } } } },
    ]);

    const candidates = await this.prisma.catalogPart.findMany({
      where: { inStock: true, OR: or },
      include: { category: true, brand: true },
      take: CANDIDATE_LIMIT,
    });

    const ranked = candidates
      .map((row) => {
        const hay = `${row.title} ${row.brand?.name ?? ''}`.toLowerCase();
        // Score = distinct QUERY tokens that matched (via any of their forms),
        // so a two-word request beats a one-word coincidental hit.
        const score = expandedByToken.reduce(
          (n, forms) => (forms.some((f) => hay.includes(f)) ? n + 1 : n),
          0,
        );
        return { row, score };
      })
      .filter((c) => c.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.row.priceUzs.toNumber() - b.row.priceUzs.toNumber(),
      )
      .slice(0, MAX_ITEMS);

    if (ranked.length === 0) return { found: false, items: [] };

    // Price the matched parts against the active sales in one query, so the chat
    // quotes what checkout will actually charge.
    const sales = await this.discounts.loadActiveSales();
    const items: StockItem[] = ranked.map(({ row }) => {
      const { finalPrice } = this.discounts.calculateDiscount(
        Number(row.priceUzs),
        { id: row.id, categoryId: row.categoryId, sellerId: row.sellerId },
        sales,
      );
      return {
        id: row.id,
        title: row.title,
        price: formatUzs(finalPrice),
        category: row.category?.name ?? null,
      };
    });

    return { found: items.length > 0, items };
  }

  /** Significant lowercase tokens (letters/digits/hyphen, len ≥ 2), deduped. */
  private tokenize(partName: string | null): string[] {
    const raw = partName?.toLowerCase().trim();
    if (!raw) return [];
    const parts = raw
      .split(/[^\p{L}\p{N}-]+/u)
      .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
    return Array.from(new Set(parts.length > 0 ? parts : [raw]));
  }
}

// Re-exported so tests can assert the loaded sales type without importing from
// the sales module directly.
export type { ActiveSale };
