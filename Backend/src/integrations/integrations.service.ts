import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeOem } from '../common/normalize-oem.util';
import {
  SyncInventoryDto,
  SyncInventoryItemDto,
  SyncMode,
} from './dto/sync-inventory.dto';
import type {
  SyncInventoryResponseDto,
  SyncSkippedItemDto,
} from './dto/sync-inventory.response.dto';
import type { IntegrationDealer } from './interfaces/integration-dealer.interface';

/**
 * How many skipped positions are echoed back. The full list can be as long as
 * the upload; a 1C operator needs a sample to diagnose the mapping, not 5000
 * rows. The counts in the response are always complete.
 */
const MAX_REPORTED_SKIPS = 50;

/** Rows written per transaction. Bounds the size and duration of any single
 *  database transaction so a large upload cannot hold locks for its entirety. */
const WRITE_CHUNK_SIZE = 500;

/**
 * Dealer 1C inventory synchronization.
 *
 * ── What it writes ──
 * Stock and price live on `CatalogPart` — the buyer-facing catalog row. The
 * sync updates `stockQty`, `inStock` and `purchasePriceUzs`, and nothing else.
 *
 * Note which price: the upload carries the dealer's ACCOUNTING/WHOLESALE price,
 * so it lands in `purchasePriceUzs` (the cost side of the Smart-Inventory margin
 * view). It deliberately does NOT touch `priceUzs`, the retail price shown to
 * buyers — that is set by MATOR, and letting a warehouse export overwrite it
 * would let a 1C misconfiguration reprice the storefront at cost.
 *
 * ── What it never does ──
 * Create catalog positions. An article the dealer does not already sell is
 * reported in `skipped`, not inserted: a catalog row needs a category, a
 * classification and images that a stock export does not carry, and inventing
 * one would put an unclassified product in front of buyers.
 */
@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async syncInventory(
    dealer: IntegrationDealer,
    dto: SyncInventoryDto,
  ): Promise<SyncInventoryResponseDto> {
    const startedAt = Date.now();
    const mode = dto.mode ?? SyncMode.PARTIAL;
    const receivedCount = dto.items.length;

    this.logger.log(
      `Inventory sync started: dealer=${dealer.id} mode=${mode} received=${receivedCount}`,
    );

    // 1. Collapse the upload by normalized article. 1C exports routinely repeat
    //    an article across warehouses; those rows are the same catalog position,
    //    so their quantities SUM rather than overwrite each other — taking the
    //    last row would silently hide every other warehouse's stock.
    const { byArticle, unusable } = this.collapseItems(dto.items);

    // 2. Resolve articles to this dealer's catalog rows. Scoped to the dealer:
    //    the where-clause below is what makes it impossible for one dealer's key
    //    to move another dealer's stock, however the articles overlap.
    const matches = await this.resolveParts(dealer.id, [...byArticle.keys()]);

    // 3. Apply, chunked, so a large upload never becomes one huge transaction.
    const { updates, mergedArticles } = this.buildUpdates(byArticle, matches);
    const processedCount = await this.applyUpdates(dealer.id, updates);

    // `processedCount` is what the DATABASE reports it changed, which can fall
    // short of what was resolved if a part was deleted or reassigned to another
    // seller between the read and the write. Rare, but it means the two numbers
    // disagree — say so rather than letting the response imply a clean run.
    if (processedCount !== updates.length) {
      this.logger.warn(
        `Dealer ${dealer.id}: resolved ${updates.length} position(s) but the database ` +
          `updated ${processedCount} — some rows changed owner or were removed mid-sync.`,
      );
    }

    // 4. In FULL mode, everything the dealer has that the upload did NOT mention
    //    is out of stock by definition.
    const zeroedCount =
      mode === SyncMode.FULL
        ? await this.zeroMissing(
            dealer.id,
            updates.map((u) => u.partId),
          )
        : 0;

    // 5. Record that this dealer's integration is alive. Best-effort: the sync
    //    itself has already succeeded, so a failure to stamp the timestamp must
    //    not turn a completed write into an error for the caller.
    await this.touchLastUsed(dealer.id);

    const skipped = this.buildSkipReport(byArticle, matches, unusable);
    const durationMs = Date.now() - startedAt;

    this.logger.log(
      `Inventory sync finished: dealer=${dealer.id} mode=${mode} ` +
        `received=${receivedCount} processed=${processedCount} ` +
        `skipped=${skipped.total} zeroed=${zeroedCount} in ${durationMs}ms ` +
        `(${this.rate(processedCount, durationMs)} rows/s)`,
    );

    if (skipped.total > 0) {
      // A high skip count means the dealer's 1C nomenclature and the catalog
      // have drifted apart — the single most common failure of this endpoint,
      // and invisible unless it is called out separately from the success line.
      this.logger.warn(
        `Dealer ${dealer.id}: ${skipped.total}/${receivedCount} positions were not applied ` +
          `(${skipped.unknown} unknown article(s), ${skipped.unusableCount} unusable article(s)).`,
      );
    }

    return {
      success: true,
      message: 'Inventory synchronized successfully',
      processedCount,
      receivedCount,
      skippedCount: skipped.total,
      // Repeats of one article, plus distinct articles that named one part.
      mergedCount: skipped.mergedCount + mergedArticles,
      zeroedCount,
      skipped: skipped.sample.length ? skipped.sample : undefined,
      durationMs,
      timestamp: new Date().toISOString(),
    };
  }

  // ── steps ──────────────────────────────────────────────────────────────────

  /**
   * Group the upload by NORMALIZED article (see normalizeOem: uppercase,
   * separators stripped) — the same canonical form the catalog stores its
   * numbers in, which is the only form in which a match can be found.
   *
   * Quantities of repeated articles sum; the price of the first occurrence wins,
   * since a single position cannot have two costs and the alternative (last one
   * wins) makes the result depend on the export's row order.
   */
  private collapseItems(items: SyncInventoryItemDto[]): {
    byArticle: Map<string, CollapsedItem>;
    unusable: string[];
  } {
    const byArticle = new Map<string, CollapsedItem>();
    const unusable: string[] = [];

    for (const item of items) {
      const normalized = normalizeOem(item.article);
      // normalizeOem keeps only A–Z and 0–9, so an article made purely of
      // punctuation OR of non-latin characters (a Cyrillic nomenclature code)
      // collapses to '' and can never match anything in the catalog. That is a
      // distinct failure from "article not found" — the number never entered the
      // search at all — so it is reported under its own reason rather than being
      // silently folded in with the misses.
      if (!normalized) {
        unusable.push(item.article);
        continue;
      }

      const existing = byArticle.get(normalized);
      if (existing) {
        // Same position quoted again (another warehouse, or the same number
        // written differently). Quantities SUM — this is a merge, not a skip,
        // and it must not be reported as a dropped position.
        existing.quantity += item.quantity;
        existing.mergedCount += 1;
        continue;
      }

      byArticle.set(normalized, {
        rawArticle: item.article,
        quantity: item.quantity,
        price: item.price,
        mergedCount: 1,
      });
    }

    return { byArticle, unusable };
  }

  /**
   * Map each normalized article to the dealer's catalog part carrying it.
   *
   * `hasSome` compiles to the PostgreSQL array-overlap operator (`&&`), which
   * the existing GIN indexes on `oem_numbers` / `gm_numbers` serve — so this is
   * ONE indexed query for the whole upload rather than a query per position.
   * Both arrays are searched because a dealer's 1C may quote either the OEM or
   * the GM number for the same part.
   */
  private async resolveParts(
    dealerId: string,
    articles: string[],
  ): Promise<Map<string, string>> {
    const resolved = new Map<string, string>();
    if (articles.length === 0) return resolved;

    // Chunked so the generated `IN`/array parameter stays a reasonable size on
    // a maximum-sized upload.
    for (const chunk of chunked(articles, WRITE_CHUNK_SIZE)) {
      const parts = await this.prisma.catalogPart.findMany({
        where: {
          sellerId: dealerId,
          OR: [
            { oemNumbers: { hasSome: chunk } },
            { gmNumbers: { hasSome: chunk } },
          ],
        },
        select: { id: true, oemNumbers: true, gmNumbers: true },
      });

      const wanted = new Set(chunk);
      for (const part of parts) {
        for (const number of [...part.oemNumbers, ...part.gmNumbers]) {
          // The row may carry numbers beyond the ones asked for; only bind the
          // articles this upload actually mentioned. First writer wins, so two
          // catalog rows sharing a number cannot flip-flop between syncs.
          if (wanted.has(number) && !resolved.has(number)) {
            resolved.set(number, part.id);
          }
        }
      }
    }

    return resolved;
  }

  /**
   * Pair each matched article with the part it updates.
   *
   * Two DIFFERENT articles can resolve to the same catalog row — a part carrying
   * both its OEM and its GM number, each quoted as a separate line by 1C. Those
   * lines are separate stock for one position, so they SUM, exactly as repeats
   * of a single article do. Writing only the first would silently discard the
   * rest of the dealer's stock for that part while still reporting success,
   * which is the worst possible outcome for a stock feed.
   */
  private buildUpdates(
    byArticle: Map<string, CollapsedItem>,
    matches: Map<string, string>,
  ): { updates: PartUpdate[]; mergedArticles: number } {
    const byPart = new Map<string, PartUpdate>();
    let mergedArticles = 0;

    for (const [article, item] of byArticle) {
      const partId = matches.get(article);
      if (!partId) continue;

      const existing = byPart.get(partId);
      if (existing) {
        existing.quantity += item.quantity;
        // Two distinct articles naming one part: count the fold so the response
        // arithmetic still reconciles (received = processed + skipped + merged).
        mergedArticles += 1;
        // The cost of the first article seen wins: one row holds one cost, and
        // summing prices would be meaningless. Deterministic because Map
        // preserves insertion order, which follows the upload's own order.
        continue;
      }

      byPart.set(partId, {
        partId,
        quantity: item.quantity,
        price: item.price,
      });
    }

    return { updates: [...byPart.values()], mergedArticles };
  }

  /**
   * Write the updates in bounded transactions. Each chunk is atomic; a failure
   * in one chunk aborts the request (the error propagates) while the chunks
   * already committed stand. That is the right trade for a stock feed: a
   * partially applied sync is re-applied verbatim by the next run, whereas
   * holding one transaction open across thousands of rows blocks the catalog.
   */
  private async applyUpdates(
    dealerId: string,
    updates: PartUpdate[],
  ): Promise<number> {
    let processed = 0;

    for (const chunk of chunked(updates, WRITE_CHUNK_SIZE)) {
      try {
        const results = await this.prisma.$transaction(
          chunk.map((u) =>
            this.prisma.catalogPart.updateMany({
              // sellerId is re-asserted on the WRITE, not just the read: even if
              // resolution were ever wrong, a dealer's key cannot write a row
              // that is not theirs.
              where: { id: u.partId, sellerId: dealerId },
              data: {
                stockQty: u.quantity,
                // Keep the legacy boolean availability flag consistent with the
                // count — the buyer catalog filters on it.
                inStock: u.quantity > 0,
                purchasePriceUzs: new Prisma.Decimal(u.price),
              },
            }),
          ),
        );
        processed += results.reduce((sum, r) => sum + r.count, 0);
      } catch (error) {
        this.logger.error(
          `Inventory sync write failed for dealer=${dealerId} ` +
            `(chunk of ${chunk.length} rows, ${processed} rows already committed): ${errorMessage(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
        throw error;
      }
    }

    return processed;
  }

  /**
   * FULL mode: zero every position of this dealer that the upload did not
   * mention. The rows are NOT deleted — the catalog entry keeps its identity,
   * images and history and simply reads as out of stock, so a part returning to
   * the warehouse comes back with the next sync instead of being recreated.
   *
   * Prices are left alone: absence from an export says nothing about cost.
   */
  private async zeroMissing(
    dealerId: string,
    touchedPartIds: string[],
  ): Promise<number> {
    // Refuse to zero a dealer's ENTIRE catalog on an upload that matched nothing.
    //
    // `notIn: []` excludes no rows, so this sweep would clear every position the
    // dealer has. A full export that resolves to zero matches is never a real
    // "everything is out of stock" — it is a broken article format, the wrong
    // dealer's file, or a mapping regression. Honouring it removes the dealer
    // from the storefront entirely while still answering 200 OK, and the next
    // correct sync cannot undo the lost sales in between. The safe reading of an
    // unintelligible full export is to apply nothing and say so loudly.
    if (touchedPartIds.length === 0) {
      this.logger.error(
        `Dealer ${dealerId}: FULL sync matched ZERO catalog positions — refusing to ` +
          `zero the dealer's entire inventory. Nothing was zeroed. This almost always ` +
          `means the export's article format no longer matches the catalog.`,
      );
      return 0;
    }

    try {
      const { count } = await this.prisma.catalogPart.updateMany({
        where: {
          sellerId: dealerId,
          id: { notIn: touchedPartIds },
          // Only rows that actually claim stock — keeps the write proportional
          // to what changes instead of rewriting the dealer's whole catalog.
          OR: [{ stockQty: { gt: 0 } }, { inStock: true }],
        },
        data: { stockQty: 0, inStock: false },
      });
      return count;
    } catch (error) {
      this.logger.error(
        `Failed to zero missing positions for dealer=${dealerId}: ${errorMessage(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  /** Stamp the integration's liveness. Best-effort by design — see caller. */
  private async touchLastUsed(dealerId: string): Promise<void> {
    try {
      await this.prisma.catalogSeller.update({
        where: { id: dealerId },
        data: { apiKeyLastUsedAt: new Date() },
      });
    } catch (error) {
      this.logger.warn(
        `Could not update apiKeyLastUsedAt for dealer=${dealerId}: ${errorMessage(error)}`,
      );
    }
  }

  // ── reporting ──────────────────────────────────────────────────────────────

  /**
   * Count the positions that were NOT applied, and build a truncated sample.
   *
   * "Skipped" means the upload row changed nothing in the catalog. A repeated
   * article is NOT skipped — its quantity was merged into the position it names,
   * so counting it here would tell a dealer stock was dropped when it was not.
   * Only two things are genuinely skipped: an article that cannot be searched at
   * all (empty after normalization) and one that matched no row of this dealer.
   */
  private buildSkipReport(
    byArticle: Map<string, CollapsedItem>,
    matches: Map<string, string>,
    unusable: string[],
  ): {
    total: number;
    unknown: number;
    unusableCount: number;
    mergedCount: number;
    sample: SyncSkippedItemDto[];
  } {
    const sample: SyncSkippedItemDto[] = [];
    let unknown = 0;
    let merged = 0;

    for (const [article, item] of byArticle) {
      // Upload rows folded into this position beyond the first one.
      merged += item.mergedCount - 1;

      if (matches.has(article)) continue;
      unknown += 1;
      if (sample.length < MAX_REPORTED_SKIPS) {
        sample.push({ article: item.rawArticle, reason: 'unknown_article' });
      }
    }

    for (const article of unusable) {
      if (sample.length >= MAX_REPORTED_SKIPS) break;
      sample.push({ article, reason: 'unusable_article' });
    }

    return {
      total: unknown + unusable.length,
      unknown,
      unusableCount: unusable.length,
      mergedCount: merged,
      sample,
    };
  }

  /** Rows per second, for the throughput line in the log. */
  private rate(rows: number, durationMs: number): number {
    if (durationMs <= 0) return rows;
    return Math.round((rows / durationMs) * 1000);
  }
}

/** One upload position after articles have been collapsed by canonical number. */
interface CollapsedItem {
  /** The article exactly as 1C sent it, for the skip report. */
  rawArticle: string;
  quantity: number;
  price: number;
  /** How many upload rows folded into this one position (1 = no repeats). */
  mergedCount: number;
}

/** A resolved write: which catalog row gets which quantity and cost. */
interface PartUpdate {
  partId: string;
  quantity: number;
  price: number;
}

/** Split an array into fixed-size chunks. */
function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
