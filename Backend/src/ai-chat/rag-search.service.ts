import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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
const CANDIDATE_LIMIT = 60;

// Very common connector words that carry no matching signal.
const STOP_WORDS = new Set([
  'для', 'на', 'нужен', 'нужна', 'нужно', 'ищу', 'мне', 'the', 'for', 'oil',
]);

/**
 * Retrieval over the buyer-facing `catalog_parts` projection.
 *
 * The extracted part phrase almost never equals a substring of the real title
 * ("Shell Helix HX7 5W-30" vs a request for "масло Shell 5w-30"), so a single
 * `title LIKE %phrase%` misses everything. Instead we TOKENISE the phrase, match
 * any token against the title OR the brand name, then RANK candidates by how many
 * distinct tokens hit — biased toward recall (an under-find wrongly opens a
 * ticket, which is worse than showing a few options).
 *
 * NOTE: this is application-side ranking, fine for the small catalog. For typo
 * tolerance + relevance at scale, move to Postgres `pg_trgm` (GIN index on
 * title + brand) — see the AI-sourcing follow-ups.
 */
@Injectable()
export class RagSearchService {
  constructor(private readonly prisma: PrismaService) {}

  async searchInStock(query: RagQuery): Promise<RagSearchResult> {
    const tokens = this.tokenize(query.partName);
    if (tokens.length === 0) return { found: false, items: [] };

    // In-stock parts matching ANY token in the title or the brand name.
    const or: Prisma.CatalogPartWhereInput[] = tokens.flatMap((t) => [
      { title: { contains: t, mode: 'insensitive' } },
      { brand: { is: { name: { contains: t, mode: 'insensitive' } } } },
    ]);

    const candidates = await this.prisma.catalogPart.findMany({
      where: { inStock: true, OR: or },
      include: { category: true, brand: true },
      take: CANDIDATE_LIMIT,
    });

    const ranked = candidates
      .map((row) => {
        const hay = `${row.title} ${row.brand?.name ?? ''}`.toLowerCase();
        const score = tokens.reduce((n, t) => (hay.includes(t) ? n + 1 : n), 0);
        return { row, score };
      })
      .filter((c) => c.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.row.priceUzs.toNumber() - b.row.priceUzs.toNumber(),
      )
      .slice(0, MAX_ITEMS);

    const items: StockItem[] = ranked.map(({ row }) => ({
      id: row.id,
      title: row.title,
      price: formatUzs(row.priceUzs),
      category: row.category?.name ?? null,
    }));

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
