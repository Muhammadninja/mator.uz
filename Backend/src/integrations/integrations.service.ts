import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeOem } from '../common/normalize-oem.util';
import { DRIVERS_VILLAGE_CATALOG_SELLER_ID } from '../imports/drivers-village/drivers-village.constants';
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

/** One FULL sync is one transaction; these bound how long it may wait and run. */
const FULL_SYNC_TX = { timeout: 60_000, maxWait: 10_000 };

type Db = Pick<Prisma.TransactionClient, 'catalogPart'>;

/**
 * The advisory lock of one dealer's inventory. A FULL sync takes it exclusively for
 * its whole transaction and each PARTIAL chunk takes it shared, so a partial write
 * can never land between a FULL sync's stock write and its zeroing.
 */
const dealerSyncLockKey = (dealerId: string) => `dealer_sync:${dealerId}`;

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
/** `catalog_parts.stock_qty` is a PostgreSQL `integer`. */
export const MAX_STOCK_QTY = 2_147_483_647;

/**
 * Refuse an upload whose summed quantity for any position would not fit the
 * stock column (LOW-ING-011). One row is bounded by the DTO; 5,000 repeats of an
 * article, or several articles naming one part, are not, and their sum used to
 * overflow `int4` after earlier chunks had committed. JavaScript sums these
 * exactly (the largest possible total, 5,000 × 1,000,000, is far inside
 * Number.MAX_SAFE_INTEGER), so the check itself cannot overflow.
 */
export function assertQuantitiesFit(
  totals: readonly { label: string; quantity: number }[],
): void {
  const over = totals.filter(
    (t) => !Number.isSafeInteger(t.quantity) || t.quantity < 0 || t.quantity > MAX_STOCK_QTY,
  );
  if (over.length === 0) return;
  throw new BadRequestException({
    code: 'SYNC_QUANTITY_OUT_OF_RANGE',
    message: `The summed quantity of ${over.length} position(s) exceeds ${MAX_STOCK_QTY}. Nothing was changed.`,
    details: { positions: over.slice(0, 20).map((t) => t.label) },
  });
}

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
    // Driver's Village stock comes from its 1C file through Telegram, which goes
    // through Stock. This endpoint writes the catalog behind that, and the next file
    // would not undo it: Stock would say 8 and buyers would see 0.
    if (dealer.id === DRIVERS_VILLAGE_CATALOG_SELLER_ID) {
      throw new ForbiddenException({
        code: 'INVENTORY_SYNC_NOT_AVAILABLE',
        message:
          'Inventory sync is not available for this dealer: its stock comes from the 1C file. Nothing was changed.',
      });
    }
    if (mode === SyncMode.FULL) this.assertCompleteUpload(dto);

    this.logger.log(
      `Inventory sync started: dealer=${dealer.id} mode=${mode} received=${receivedCount}`,
    );

    // 1. Collapse the upload by normalized article. 1C exports routinely repeat
    //    an article across warehouses; those rows are the same catalog position,
    //    so their quantities SUM rather than overwrite each other — taking the
    //    last row would silently hide every other warehouse's stock.
    const { byArticle, unusable } = this.collapseItems(dto.items);
    // LOW-ING-011: summed repeats are checked against the column before the
    // database is even read, so neither mode can write part of an upload and
    // then fail on a total that does not fit.
    assertQuantitiesFit(
      [...byArticle.values()].map((i) => ({ label: i.rawArticle, quantity: i.quantity })),
    );

    // 2. Resolve articles to this dealer's catalog rows. Scoped to the dealer:
    //    the where-clause below is what makes it impossible for one dealer's key
    //    to move another dealer's stock, however the articles overlap.
    // 3. Apply. PARTIAL is chunked, so a large upload never becomes one huge
    //    transaction. FULL is all or nothing: see applyFull.
    const { matches, updates, mergedArticles, processedCount, zeroedCount } =
      mode === SyncMode.FULL
        ? await this.applyFull(dealer.id, byArticle)
        : await this.applyPartial(dealer.id, byArticle);

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

    // 4. Record that this dealer's integration is alive. Best-effort: the sync
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
   * A sender that says how many rows its export has is refused, before anything is
   * read or written, unless this request carries all of them. Stating it is optional:
   * a FULL request without it means what it always has.
   */
  private assertCompleteUpload(dto: SyncInventoryDto): void {
    if (
      dto.expectedTotal !== undefined &&
      dto.expectedTotal !== dto.items.length
    ) {
      throw new BadRequestException({
        code: 'FULL_SYNC_INCOMPLETE',
        message:
          'mode=full must carry the whole export in one request. Nothing was changed. Use mode=partial to send pages.',
      });
    }
  }

  private async applyPartial(
    dealerId: string,
    byArticle: Map<string, CollapsedItem>,
  ) {
    const matches = await this.resolveParts(
      this.prisma,
      dealerId,
      [...byArticle.keys()],
    );
    const { updates, mergedArticles } = this.buildUpdates(byArticle, matches);
    // Distinct articles that name one part sum too: checked before the first chunk.
    assertQuantitiesFit(updates.map((u) => ({ label: u.partId, quantity: u.quantity })));
    const processedCount = await this.applyUpdates(dealerId, updates);
    return { matches, updates, mergedArticles, processedCount, zeroedCount: 0 };
  }

  /**
   * FULL mode, in one transaction under the dealer's lock: the stock write and the
   * zeroing commit together or not at all, and two syncs of one dealer run one after
   * the other, so the result is always one complete upload. The stock is written in
   * a single statement, so 5,000 rows cost one round trip while the locks are held.
   */
  private applyFull(dealerId: string, byArticle: Map<string, CollapsedItem>) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${dealerSyncLockKey(dealerId)}))`;
      const matches = await this.resolveParts(tx, dealerId, [
        ...byArticle.keys(),
      ]);
      const { updates, mergedArticles } = this.buildUpdates(byArticle, matches);
      // Before the write and the zeroing: a refusal here rolls back nothing,
      // because nothing has been written yet.
      assertQuantitiesFit(
        updates.map((u) => ({ label: u.partId, quantity: u.quantity })),
      );
      const processedCount = updates.length
        ? await tx.$executeRaw`
            UPDATE catalog_parts AS p
            SET stock_qty = v.qty,
                in_stock = v.qty > 0,
                purchase_price_uzs = v.price,
                updated_at = now()
            FROM unnest(
              ${updates.map((u) => u.partId)}::text[],
              ${updates.map((u) => u.quantity)}::int[],
              ${updates.map((u) => String(u.price))}::text[]::numeric[]
            ) AS v(id, qty, price)
            WHERE p.id = v.id AND p.seller_id = ${dealerId}`
        : 0;
      // Everything the dealer has that the upload did NOT mention is out of stock
      // by definition.
      const zeroedCount = await this.zeroMissing(
        tx,
        dealerId,
        updates.map((u) => u.partId),
      );
      return { matches, updates, mergedArticles, processedCount, zeroedCount };
    }, FULL_SYNC_TX);
  }

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
    db: Db,
    dealerId: string,
    articles: string[],
  ): Promise<Map<string, string>> {
    const resolved = new Map<string, string>();
    if (articles.length === 0) return resolved;

    // Chunked so the generated `IN`/array parameter stays a reasonable size on
    // a maximum-sized upload.
    for (const chunk of chunked(articles, WRITE_CHUNK_SIZE)) {
      const parts = await db.catalogPart.findMany({
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
        const [, ...results] = await this.prisma.$transaction([
          // Shared: partial chunks never wait for each other, only for a FULL sync.
          this.prisma.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${dealerSyncLockKey(dealerId)}))`,
          ...chunk.map((u) =>
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
        ]);
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
    db: Db,
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
      const { count } = await db.catalogPart.updateMany({
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
