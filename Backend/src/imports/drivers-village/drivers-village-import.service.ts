/**
 * Driver's Village 1C import — the price/stock synchronization (run by hand or
 * by the Telegram ingest timer).
 *
 *   1C text export ──► read + decode ──► parse rows ──► plan against the DB
 *        ──► (dry run: report) / (import: batched writes ──► projection)
 *
 * The importer writes the SUPPLY side only (Product / Stock / part_models /
 * part_makes) and then hands each written Stock to the existing
 * CatalogProjectionService — the single Stock → CatalogPart mapping. It never
 * writes the buyer catalog itself.
 *
 * Guarantees:
 *   • A position is found by its exact (seller, DRIVERS_VILLAGE_1C, code_1c)
 *     only. A code without a position of its own is a NEW position — never a
 *     takeover of another code's position, whatever their 8-digit keys say;
 *     a shared key is reported (drivers-village-code-key.ts).
 *   • A stored position is SYNCHRONIZED, not re-imported: only its stock price
 *     and — when the file states one — its quantity are written, and only the
 *     catalog columns those feed (projectStockLevels). Its name, numbers,
 *     unit, vehicle links (part_models / part_makes / catalog_part_fits),
 *     category, photos and catalog settings are never touched; where the file
 *     differs, the report lists it (`notApplied`).
 *   • A new position is CREATED from the file (initial creation): name, unit,
 *     code_1c as its part number, price, quantity, and the vehicles of every
 *     row of its code. No category — it starts unclassified. Empty vehicle
 *     cells add no link and never make a part universal.
 *   • Dry run: every read, parse, match and validation step runs; no write
 *     method of the store is ever called.
 *   • Idempotent: a re-import of the same file plans every row as unchanged
 *     and writes nothing; no position is ever created twice.
 *   • One position per code_1c: a code on several rows is written once, at the
 *     highest valid price among them (resolveDuplicateCodes); a code with no
 *     valid price writes nothing, so its stored price stays. Rows stating
 *     different quantities give no confirmed count: none is written.
 *   • Batched: each batch is one transaction — all of its positions or none.
 *     A failed batch stops the run; committed batches stand, and re-running the
 *     same file resumes (committed rows plan as unchanged, missing
 *     projections are re-done).
 *   • Explicit seller: positions belong to the BUSINESS supply-side seller
 *     linked to the catalog dealer 'drivers-village' (sellers.catalog_seller_id,
 *     tg_id NULL). The importer never creates a seller; a missing or
 *     non-BUSINESS link is a setup error that blocks the import.
 *   • One price rule, applied once: the file's price goes through
 *     normalizeSourcePrice (below 1000 → ×1000) while the row is parsed, and
 *     the result is written to Stock.priceUzs and projected to
 *     CatalogPart.priceUzs — no markup, no rounding. A stored price is never
 *     an input, so re-importing a file cannot scale a price twice.
 *   • Absence is not deletion: positions missing from a file are listed, never
 *     changed, zeroed or deleted.
 */
import { createHash } from 'crypto';
import {
  DRIVERS_VILLAGE_CATALOG_SELLER_ID,
  DRIVERS_VILLAGE_SOURCE_SYSTEM,
  IMPORT_LIMITS,
  PRICE_JUMP_REVIEW_RATIO,
} from './drivers-village.constants';
import { mapHeaders, parseRow } from './drivers-village-row.parser';
import {
  keySharedIssue,
  resolveCodeKeys,
  sameSearchNumberIssue,
} from './drivers-village-code-key';
import type { NumberFormat } from './drivers-village-price';
import {
  buildCreate,
  cardDifferences,
  detectRowNumberCodes,
  findFitsNotInReference,
  findLookAlikes,
  isPriceJump,
  isUnclassified,
  planStockSync,
  resolveDuplicateCodes,
  type SourceLine,
} from './drivers-village.planner';
import type {
  ImportReport,
  RowReport,
  VehicleMappingSummary,
} from './drivers-village.report';
import { checkEnvironment } from './drivers-village-environment';
import type { DriversVillageStore } from './drivers-village.store';
import type {
  BatchWrite,
  ExistingPosition,
  ParsedRow,
  RowPlan,
  VehicleLinks,
} from './drivers-village.types';
import {
  decodeSource,
  detectDelimiter,
  parseDelimited,
  type SourceEncoding,
} from './tsv-reader';

/** The number format follows the export format (see NumberFormat). */
const NUMBER_FORMAT = {
  tab: 'decimal-comma',
  semicolon: 'thousands-comma',
} as const satisfies Record<string, NumberFormat>;

export interface ImportOptions {
  dryRun: boolean;
  encoding?: SourceEncoding;
  /** Defaults to 'drivers-village'. Only tests pass anything else. */
  catalogSellerId?: string;
  batchSize?: number;
}

/** The projection capabilities the importer needs (CatalogProjectionService). */
export interface StockProjector {
  /** Full projection — a new position's catalog part. */
  projectStock(stockId: number): Promise<string | null>;
  /** Only the synced price / quantity of an existing catalog part. */
  projectStockLevels(
    stockId: number,
    changed: { price: boolean; quantity: boolean },
  ): Promise<string | null>;
}

export class DriversVillageImportService {
  constructor(
    private readonly store: DriversVillageStore,
    private readonly projector: StockProjector,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  async run(
    bytes: Uint8Array,
    fileName: string,
    options: ImportOptions,
  ): Promise<ImportReport> {
    const startedAt = new Date();
    const catalogSellerId =
      options.catalogSellerId ?? DRIVERS_VILLAGE_CATALOG_SELLER_ID;
    const report = emptyReport(
      options.dryRun,
      fileName,
      bytes,
      catalogSellerId,
      startedAt,
    );
    const finish = () => {
      const finishedAt = new Date();
      report.meta.finishedAt = finishedAt.toISOString();
      report.meta.durationMs = finishedAt.getTime() - startedAt.getTime();
      return report;
    };
    const abort = (reason: string) => {
      report.meta.aborted = true;
      report.meta.abortReason = reason;
      return finish();
    };

    // ── 1. Read ──────────────────────────────────────────────────────────────
    if (bytes.length > IMPORT_LIMITS.maxFileBytes) {
      return abort(
        `File is ${bytes.length} bytes; the limit is ${IMPORT_LIMITS.maxFileBytes}.`,
      );
    }
    let decoded: ReturnType<typeof decodeSource>;
    let parsedRecords: ReturnType<typeof parseDelimited>;
    let delimiter: ReturnType<typeof detectDelimiter>;
    try {
      decoded = decodeSource(bytes, options.encoding);
      // The delimiter comes from the header's structure: the one that yields
      // every required column; a header valid both ways is refused.
      delimiter = detectDelimiter(
        decoded.text,
        (cells) => mapHeaders(cells).errors.length === 0,
      );
      parsedRecords = delimiter.ok
        ? parseDelimited(decoded.text, delimiter.delimiter)
        : [];
    } catch (error) {
      return abort(
        `Cannot read the file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    report.meta.encoding = decoded.encoding;
    report.meta.encodingDetected = decoded.detected;
    if (!delimiter.ok) return abort(delimiter.reason);
    const numberFormat = NUMBER_FORMAT[delimiter.name];
    report.meta.delimiter = delimiter.name;
    report.meta.numberFormat = numberFormat;
    const [header, ...records] = parsedRecords;
    if (!header) return abort('The file has no header row.');
    if (records.length > IMPORT_LIMITS.maxRows) {
      return abort(
        `The file has ${records.length} data rows; the limit is ${IMPORT_LIMITS.maxRows}.`,
      );
    }
    const headers = mapHeaders(header.cells);
    report.headers = {
      columns: header.cells.map((c) => c.trim()),
      mapped: headers.source,
      ignored: headers.ignored,
      notImported: headers.notImported,
    };
    if (headers.errors.length)
      return abort(`Header problems: ${headers.errors.join(' ')}`);

    // ── 2. Parse ─────────────────────────────────────────────────────────────
    const rowReports = new Map<number, RowReport>();
    const lines: SourceLine[] = [];
    for (const rec of records) {
      const result = parseRow(rec.cells, rec.line, headers, numberFormat);
      rowReports.set(rec.line, {
        line: rec.line,
        code1c: result.code1c,
        outcome: result.row ? 'create' : 'rejected',
        changes: [],
        issues: result.issues,
      });
      lines.push({ line: rec.line, ...result });
    }
    report.summary.totalRows = records.length;

    // A code_1c column of row numbers (1…N) means the part numbers are not in
    // the file at all; importing it would overwrite every part number.
    const rowNumbers = detectRowNumberCodes(lines.map((l) => l.code1c));
    if (rowNumbers) {
      return abort(
        `code_1c looks like row numbers, not part numbers: ${rowNumbers.distinct} of ${rowNumbers.rows} rows hold distinct whole numbers from ${rowNumbers.min} to ${rowNumbers.max}. Nothing was imported — check that code_1c holds the articles.`,
      );
    }

    // One position per code_1c: the rows of a repeated code are folded into
    // the one with the highest valid price (see resolveDuplicateCodes).
    const codes = resolveDuplicateCodes(lines);
    for (const [line, patch] of codes.patches) {
      const r = rowReports.get(line)!;
      r.issues = patch.issues;
      if (patch.outcome) r.outcome = patch.outcome;
    }
    report.duplicates = codes.duplicates;
    report.summary.duplicateSourceCodes = codes.duplicates.length;
    report.summary.duplicateCodesMaxPrice = codes.duplicates.filter(
      (d) => d.chosenLine !== null,
    ).length;
    report.summary.codesWithoutValidPrice = codes.codesWithoutValidPrice.length;
    report.summary.codesWithAmbiguousQuantity = codes.duplicates.filter(
      (d) => d.chosenLine !== null && d.differs.includes('quantity'),
    ).length;
    const valid = codes.positions;
    this.summarizeSource(report, valid, codes.vehicles);

    // ── 3. Environment (reference data in THIS database) ────────────────────
    const env = await checkEnvironment(this.store, catalogSellerId);
    const { catalogSeller, linked } = env;
    report.environment.catalogSeller = catalogSeller;
    report.environment.linkedSellerId = linked?.id ?? null;
    report.environment.linkedSellerStatus = linked?.status ?? null;
    report.environment.linkedSellerType = linked?.sellerType ?? null;
    report.environment.issues.push(...env.issues);
    // ── 4. Plan ──────────────────────────────────────────────────────────────
    // A position is found by its exact code_1c only: a stored one is
    // synchronized (price, a stated quantity), any other is created. Shared
    // 8-digit keys and search numbers are reported, never acted on.
    const storedCodes = linked
      ? await this.store.loadAllSourceCodes(linked.id)
      : [];
    const keys = resolveCodeKeys(
      [...rowReports.values()].flatMap((r) => (r.code1c ? [r.code1c] : [])),
      storedCodes,
    );
    const existing = linked
      ? await this.store.loadPositions(
          linked.id,
          valid.map((r) => r.code1c),
        )
      : new Map<string, ExistingPosition>();
    const plans: RowPlan[] = [];
    const creates: { row: ParsedRow; links: VehicleLinks }[] = [];
    for (const row of valid) {
      const rr = rowReports.get(row.line)!;
      const links = codes.vehicles.get(row.code1c) ?? { models: [], makes: [] };
      const prev = existing.get(row.code1c) ?? null;
      rr.price = {
        source: row.sourcePrice,
        scaled: row.priceScaled,
        from: prev?.priceUzs ?? null,
        to: row.priceUzs,
      };
      rr.quantity = { from: prev?.quantity ?? null, to: row.quantity };

      if (!prev) {
        const shared = keys.shared.get(row.code1c);
        if (shared) {
          rr.issues.push(keySharedIssue(row, shared));
          report.keyShared.push({
            ...shared,
            line: row.line,
            code1c: row.code1c,
          });
        }
        const same = keys.sameSearchNumber.get(row.code1c);
        if (same) rr.issues.push(sameSearchNumberIssue(row, same));
        rr.outcome = 'create';
        rr.partNumber = { from: null, to: row.sourcePartNumber };
        creates.push({ row, links });
        plans.push({
          row,
          action: 'create',
          write: buildCreate(row, links, keys.searchKeys.get(row.code1c)),
          changes: [],
          existing: null,
        });
        continue;
      }

      const { changes, write } = planStockSync(row, prev);
      const action = write ? 'update' : 'unchanged';
      rr.outcome = action;
      rr.changes = changes;
      const notApplied = cardDifferences(row, links, prev);
      if (notApplied.length) rr.notApplied = notApplied;
      if (changes.includes('price') && isPriceJump(prev.priceUzs, row.priceUzs))
        rr.issues.push({
          line: row.line,
          code1c: row.code1c,
          kind: 'data',
          severity: 'warning',
          code: 'price_jump',
          field: 'price',
          message: `price changes from ${prev.priceUzs} to ${row.priceUzs} UZS (source "${row.sourcePrice}") — ${PRICE_JUMP_REVIEW_RATIO}× or more; check the scale of the export and of the stored price`,
        });
      if (isUnclassified(prev.categoryId))
        report.summary.existingWithoutCategory += 1;
      plans.push({ row, action, write, changes, existing: prev });
    }
    // Fitment is written for new positions only: check those against the
    // buyer vehicle reference.
    const fitCheck = findFitsNotInReference(
      creates,
      await this.store.loadVehicleReference(),
    );
    report.vehicles.notInBuyerReference = fitCheck.missing;
    for (const issue of fitCheck.issues)
      rowReports.get(issue.line!)!.issues.push(issue);
    report.summary.existingPositionsWithPhotos = [...existing.values()].filter(
      (p) => p.imageCount > 0,
    ).length;
    const inFile = new Set([...rowReports.values()].map((r) => r.code1c));
    report.positionsNotInFile = storedCodes
      .filter((c) => !inFile.has(c))
      .sort();
    report.rows = [...rowReports.values()].sort((a, b) => a.line - b.line);
    report.prices.examples = priceExamples(report.rows);
    this.summarizeOutcomes(report);

    if (options.dryRun) return finish();

    // ── 5. Import ────────────────────────────────────────────────────────────
    const setupErrors = report.environment.issues.filter(
      (i) => i.severity === 'error',
    );
    if (!catalogSeller || !linked || setupErrors.length > 0) {
      return abort(
        `Setup error — nothing was written: ${setupErrors.map((i) => i.message).join(' ')}`,
      );
    }
    await this.write(
      report,
      plans,
      linked.id,
      rowReports,
      options.batchSize ?? IMPORT_LIMITS.batchSize,
    );
    return finish();
  }

  private async write(
    report: ImportReport,
    plans: RowPlan[],
    sellerId: number,
    rows: Map<number, RowReport>,
    batchSize: number,
  ): Promise<void> {
    const written = {
      created: 0,
      updated: 0,
      skippedUnchanged: 0,
      projected: 0,
      projectionFailures: 0,
    };
    report.summary.written = written;
    const toWrite = plans.filter(
      (p): p is RowPlan & { write: BatchWrite } => p.write !== null,
    );
    // code_1c → the stock and what its catalog part needs: `levels` for a
    // synced stock (only the changed price/quantity), null for a full
    // projection (a new position, or one whose part is missing).
    const toProject = new Map<
      string,
      { stockId: number; levels: { price: boolean; quantity: boolean } | null }
    >();

    for (const p of plans) {
      if (p.action !== 'unchanged') continue;
      rows.get(p.row.line)!.written = 'skipped_unchanged';
      written.skippedUnchanged += 1;
      // Resume path: a batch committed but its projection never ran.
      if (p.existing && !p.existing.hasCatalogPart)
        toProject.set(p.row.code1c, {
          stockId: p.existing.stockId,
          levels: null,
        });
    }
    for (const p of toWrite) rows.get(p.row.line)!.written = 'not_written';

    for (let i = 0; i < toWrite.length; i += batchSize) {
      const batch = toWrite.slice(i, i + batchSize);
      try {
        const result = await this.store.applyBatch(
          sellerId,
          batch.map((p) => p.write),
        );
        for (const w of result) {
          const plan = batch.find((p) => p.write.code1c === w.code1c)!;
          rows.get(plan.row.line)!.written = w.created ? 'created' : 'updated';
          if (w.created) written.created += 1;
          else written.updated += 1;
          toProject.set(w.code1c, {
            stockId: w.stockId,
            levels:
              plan.write.kind === 'sync'
                ? {
                    price: plan.write.priceUzs !== null,
                    quantity: plan.write.quantity !== null,
                  }
                : null,
          });
        }
        this.log(
          `batch ${i / batchSize + 1}: wrote ${result.length} position(s) (${i + batch.length}/${toWrite.length})`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        report.meta.aborted = true;
        report.meta.abortReason = `Batch starting at position ${i + 1} failed and was rolled back: ${message}. Earlier batches are committed; re-run the same file to resume.`;
        break;
      }
    }

    // Project every written (or previously unprojected) stock through the one
    // shared mapping — a synced one only in the columns it changed. A failure
    // is recorded, not fatal: supply data is committed, and re-running the
    // import re-projects anything missing.
    const lineByCode = new Map(plans.map((p) => [p.row.code1c, p.row.line]));
    for (const [code1c, { stockId, levels }] of toProject) {
      try {
        if (levels) await this.projector.projectStockLevels(stockId, levels);
        else await this.projector.projectStock(stockId);
        written.projected += 1;
        rows.get(lineByCode.get(code1c)!)!.projected = true;
      } catch (error) {
        written.projectionFailures += 1;
        rows.get(lineByCode.get(code1c)!)!.projected = false;
        report.projectionFailures.push({
          code1c,
          stockId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Source-side statistics (units, vehicle normalization, look-alikes), per
   * position — the vehicles merged over the rows of its code.
   */
  private summarizeSource(
    report: ImportReport,
    rows: ParsedRow[],
    vehicles: Map<string, VehicleLinks>,
  ): void {
    const mappings = new Map<string, VehicleMappingSummary>();
    for (const r of rows) {
      report.units[r.unit] = (report.units[r.unit] ?? 0) + 1;
      if (r.quantity === null) report.summary.rowsWithoutQuantity += 1;
      if (r.priceScaled) report.summary.rowsWithScaledPrice += 1;
      const v = report.vehicles;
      const links = vehicles.get(r.code1c) ?? { models: [], makes: [] };
      if (links.models.length === 0 && links.makes.length === 0)
        v.rowsWithoutVehicles += 1;
      if (links.makes.length > 0) v.makeWideRows += 1;
      if (links.models.length > 0) {
        v.specificModelRows += 1;
        v.modelLinks += links.models.length;
        if (links.models.length > 1) v.multiModelRows += 1;
      }
      for (const m of r.vehicleMappings) {
        const key = `${m.sourceMake}|${m.sourceModel ?? ''}`;
        const agg = mappings.get(key) ?? { ...m, rows: 0 };
        agg.rows += 1;
        mappings.set(key, agg);
      }
    }
    report.vehicles.mappings = [...mappings.values()].sort((a, b) =>
      `${a.sourceMake}|${a.sourceModel ?? ''}`.localeCompare(
        `${b.sourceMake}|${b.sourceModel ?? ''}`,
      ),
    );
    report.lookAlikes = findLookAlikes(rows);
  }

  private summarizeOutcomes(report: ImportReport): void {
    const s = report.summary;
    for (const r of report.rows) {
      if (r.outcome === 'rejected') s.rejectedRows += 1;
      else if (r.outcome === 'create') {
        s.rowsToCreate += 1;
        if (r.issues.some((i) => i.code === 'code_key_shared'))
          s.rowsToCreateWithSharedKey += 1;
      } else if (r.outcome === 'update') s.rowsToUpdate += 1;
      else if (r.outcome === 'merged') s.rowsMerged += 1;
      else s.rowsUnchanged += 1;
      if (r.outcome === 'update' && r.changes.includes('price'))
        s.rowsWithPriceChange += 1;
      if (r.outcome === 'update' && r.changes.includes('quantity'))
        s.rowsWithQuantityChange += 1;
      if (r.notApplied?.length) s.rowsWithCardDifferences += 1;
      for (const i of r.issues) {
        const isError = i.severity === 'error';
        if (i.kind === 'data') {
          if (isError) s.dataErrors += 1;
          else s.dataWarnings += 1;
        } else if (isError) s.referenceErrors += 1;
        else s.referenceWarnings += 1;
      }
    }
    s.validRows = s.totalRows - s.rejectedRows;
    // Every new position is created unclassified (the import sets no category).
    s.newWithoutCategory = s.rowsToCreate;
    s.lookAlikeGroups = report.lookAlikes.length;
    s.positionsNotInFile = report.positionsNotInFile.length;
    s.rowsWithPossibleRename = report.keyShared.filter(
      (k) => k.possibleRenameOf.length > 0,
    ).length;
  }
}

/**
 * The first few scaled and unscaled prices of the file, in file order, so a
 * reviewer sees the rule applied to real cells (×1000 below 1000, as-is above).
 */
function priceExamples(
  rows: RowReport[],
  perKind = 5,
): ImportReport['prices']['examples'] {
  const pick = (scaled: boolean) =>
    rows
      .filter((r) => r.price && r.code1c && r.price.scaled === scaled)
      .slice(0, perKind)
      .map((r) => ({ line: r.line, code1c: r.code1c!, ...r.price! }));
  return [...pick(true), ...pick(false)].sort((a, b) => a.line - b.line);
}

function emptyReport(
  dryRun: boolean,
  fileName: string,
  bytes: Uint8Array,
  catalogSellerId: string,
  startedAt: Date,
): ImportReport {
  return {
    meta: {
      mode: dryRun ? 'dry-run' : 'import',
      file: fileName,
      fileSha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      encoding: '',
      encodingDetected: false,
      delimiter: null,
      numberFormat: null,
      catalogSellerId,
      sourceSystem: DRIVERS_VILLAGE_SOURCE_SYSTEM,
      currency: 'UZS',
      startedAt: startedAt.toISOString(),
      finishedAt: '',
      durationMs: 0,
      aborted: false,
      abortReason: null,
    },
    headers: { columns: [], mapped: {}, ignored: [], notImported: [] },
    environment: {
      catalogSeller: null,
      linkedSellerId: null,
      linkedSellerStatus: null,
      linkedSellerType: null,
      issues: [],
    },
    summary: {
      totalRows: 0,
      validRows: 0,
      rejectedRows: 0,
      rowsToCreate: 0,
      rowsToUpdate: 0,
      rowsUnchanged: 0,
      rowsWithPriceChange: 0,
      rowsWithQuantityChange: 0,
      rowsWithCardDifferences: 0,
      rowsWithScaledPrice: 0,
      newWithoutCategory: 0,
      existingWithoutCategory: 0,
      duplicateSourceCodes: 0,
      duplicateCodesMaxPrice: 0,
      rowsMerged: 0,
      codesWithoutValidPrice: 0,
      codesWithAmbiguousQuantity: 0,
      rowsToCreateWithSharedKey: 0,
      rowsWithPossibleRename: 0,
      dataErrors: 0,
      dataWarnings: 0,
      referenceErrors: 0,
      referenceWarnings: 0,
      lookAlikeGroups: 0,
      positionsNotInFile: 0,
      existingPositionsWithPhotos: 0,
      rowsWithoutQuantity: 0,
      written: null,
    },
    vehicles: {
      rowsWithoutVehicles: 0,
      makeWideRows: 0,
      specificModelRows: 0,
      multiModelRows: 0,
      modelLinks: 0,
      mappings: [],
      notInBuyerReference: [],
    },
    prices: { examples: [] },
    units: {},
    duplicates: [],
    keyShared: [],
    lookAlikes: [],
    positionsNotInFile: [],
    projectionFailures: [],
    rows: [],
  };
}
