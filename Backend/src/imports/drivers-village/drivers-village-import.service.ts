/**
 * Driver's Village 1C import — orchestration.
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
 *   • Dry run: every read, parse, match and validation step runs; no write
 *     method of the store is ever called.
 *   • Idempotent: a position is keyed by (seller, DRIVERS_VILLAGE_1C, code_1c);
 *     a re-import updates it in place, and an unchanged row is not rewritten.
 *     A code_1c without a position of its own may take over the position of a
 *     changed code through its 8-digit key (`96273708` → `96273708 GMB`) —
 *     only when that is unambiguous; otherwise the row is a 'conflict' and
 *     nothing is written for it (drivers-village-code-key.ts).
 *   • code_1c is the part number: it is written to products.source_part_number
 *     (and the oem_numbers index) on create and update, so a wrong stored
 *     number is corrected by the next import. The export's
 *     manufacturer_part_number / oem_numbers cells are never read, and a
 *     stored part number never decides which position a row updates.
 *   • One position per code_1c: a code on several rows is written once, at the
 *     highest valid price among them (resolveDuplicateCodes); a code with no
 *     valid price writes nothing, so its stored price stays.
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
 *   • Mator owns classification: the import writes no category. A new
 *     position is created unclassified; an existing one keeps its category
 *     (the projection does not overwrite an imported position's category).
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
  keyConflictIssue,
  keyMatchIssue,
  keySharedIssue,
  resolveCodeKeys,
} from './drivers-village-code-key';
import type { NumberFormat } from './drivers-village-price';
import {
  buildWrite,
  detectRowNumberCodes,
  diffPosition,
  findFitsNotInReference,
  findLookAlikes,
  isPriceJump,
  isUnclassified,
  resolveDuplicateCodes,
  type SourceLine,
} from './drivers-village.planner';
import type {
  ImportReport,
  RowReport,
  VehicleMappingSummary,
} from './drivers-village.report';
import {
  REQUIRED_MIGRATIONS,
  type DriversVillageStore,
} from './drivers-village.store';
import type {
  ExistingPosition,
  ImportIssue,
  ParsedRow,
  RowPlan,
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

/** The one projection capability the importer needs. */
export interface StockProjector {
  projectStock(stockId: number): Promise<string | null>;
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
    const valid = codes.positions;
    this.summarizeSource(report, valid);

    // ── 3. Environment (reference data in THIS database) ────────────────────
    const envIssue = (
      code: string,
      message: string,
      severity: 'error' | 'warning' = 'error',
    ): ImportIssue => ({
      line: null,
      code1c: null,
      kind: 'reference',
      severity,
      code,
      field: null,
      message,
    });
    const schemaReady = await this.store.schemaReady();
    if (!schemaReady) {
      report.environment.issues.push(
        envIssue(
          'schema_not_migrated',
          `This database does not have migrations ${REQUIRED_MIGRATIONS.join(' and ')} yet (run \`npx prisma migrate deploy\`). Existing positions cannot be read, so every valid row is planned as a create.`,
        ),
      );
    }
    const catalogSeller = await this.store.findCatalogSeller(catalogSellerId);
    report.environment.catalogSeller = catalogSeller;
    if (!catalogSeller) {
      report.environment.issues.push(
        envIssue(
          'catalog_seller_missing',
          `Catalog seller "${catalogSellerId}" does not exist in this database. The importer never creates it.`,
        ),
      );
    }
    const linked = schemaReady
      ? await this.store.findLinkedSeller(catalogSellerId)
      : null;
    report.environment.linkedSellerId = linked?.id ?? null;
    report.environment.linkedSellerStatus = linked?.status ?? null;
    report.environment.linkedSellerType = linked?.sellerType ?? null;
    if (!linked && schemaReady) {
      report.environment.issues.push(
        envIssue(
          'linked_seller_missing',
          `Setup required: no supply-side seller is linked to catalog seller "${catalogSellerId}". ` +
            `Create the Driver's Village BUSINESS seller (tg_id NULL) with catalog_seller_id = "${catalogSellerId}" ` +
            `as described in docs/DRIVERS_VILLAGE_IMPORT.md §1. The importer never creates a seller.`,
        ),
      );
    }
    if (linked && linked.sellerType !== 'BUSINESS') {
      // Driver's Village is an organization fed by 1C, not a Telegram account.
      // A TELEGRAM seller linked here is a setup mistake (someone's bot account
      // would own the dealer's whole inventory), so it blocks the import.
      report.environment.issues.push(
        envIssue(
          'linked_seller_not_business',
          `Seller #${linked.id} linked to "${catalogSellerId}" is a ${linked.sellerType} seller; ` +
            `the Driver's Village seller must be a BUSINESS seller (docs/DRIVERS_VILLAGE_IMPORT.md §1).`,
        ),
      );
    }
    if (linked && linked.status !== 'ACTIVE') {
      report.environment.issues.push(
        envIssue(
          'linked_seller_not_active',
          `Seller #${linked.id} linked to "${catalogSellerId}" has status ${linked.status} (expected ACTIVE).`,
          'warning',
        ),
      );
    }
    const fitCheck = findFitsNotInReference(
      valid,
      await this.store.loadVehicleReference(),
    );
    report.vehicles.notInBuyerReference = fitCheck.missing;
    for (const issue of fitCheck.issues)
      rowReports.get(issue.line!)!.issues.push(issue);

    // ── 4. Plan ──────────────────────────────────────────────────────────────
    // A code_1c updates the position stored under it; one without a position
    // of its own may update the position of a changed code through its 8-digit
    // key, when that is unambiguous (resolveCodeKeys).
    const storedCodes = linked
      ? await this.store.loadAllSourceCodes(linked.id)
      : [];
    const keys = resolveCodeKeys(
      [...rowReports.values()].flatMap((r) => (r.code1c ? [r.code1c] : [])),
      storedCodes,
    );
    const planned = new Set(valid.map((r) => r.code1c));
    const existing = linked
      ? await this.store.loadPositions(linked.id, [
          ...planned,
          ...[...keys.matches]
            .filter(([code]) => planned.has(code))
            .map(([, m]) => m.storedCode),
        ])
      : new Map<string, ExistingPosition>();
    const plans: RowPlan[] = [];
    for (const row of valid) {
      const rr = rowReports.get(row.line)!;
      const conflict = keys.conflicts.get(row.code1c);
      if (conflict) {
        rr.outcome = 'conflict';
        rr.issues.push(keyConflictIssue(row, conflict));
        continue;
      }
      const shared = keys.shared.get(row.code1c);
      if (shared) {
        rr.issues.push(keySharedIssue(row, shared));
        report.keyShared.push({
          ...shared,
          line: row.line,
          code1c: row.code1c,
        });
      }
      const match = keys.matches.get(row.code1c);
      const prev = existing.get(match?.storedCode ?? row.code1c) ?? null;
      const write = buildWrite(row, {
        previousCode1c: match && prev ? match.storedCode : undefined,
        searchKey: keys.searchKeys.get(row.code1c),
      });
      if (match && prev) {
        rr.issues.push(keyMatchIssue(row, match, prev.stockId));
        report.keyMatches.push({
          ...match,
          line: row.line,
          code1c: row.code1c,
          stockId: prev.stockId,
        });
      }
      const changes = prev ? diffPosition(write, prev) : [];
      const action = !prev ? 'create' : changes.length ? 'update' : 'unchanged';
      rr.outcome = action;
      rr.changes = changes;
      rr.price = {
        source: row.sourcePrice,
        scaled: row.priceScaled,
        from: prev?.priceUzs ?? null,
        to: write.priceUzs,
      };
      rr.quantity = { from: prev?.quantity ?? null, to: write.quantity };
      rr.partNumber = {
        from: prev?.sourcePartNumber ?? null,
        to: row.sourcePartNumber,
      };
      if (
        prev &&
        changes.includes('price') &&
        isPriceJump(prev.priceUzs, write.priceUzs)
      )
        rr.issues.push({
          line: row.line,
          code1c: row.code1c,
          kind: 'data',
          severity: 'warning',
          code: 'price_jump',
          field: 'price',
          message: `price changes from ${prev.priceUzs} to ${write.priceUzs} UZS (source "${row.sourcePrice}") — ${PRICE_JUMP_REVIEW_RATIO}× or more; check the scale of the export and of the stored price`,
        });
      if (prev && isUnclassified(prev.categoryId))
        report.summary.existingWithoutCategory += 1;
      plans.push({ row, action, write, changes, existing: prev });
    }
    report.summary.existingPositionsWithPhotos = [...existing.values()].filter(
      (p) => p.imageCount > 0,
    ).length;
    const inFile = new Set([
      ...[...rowReports.values()].map((r) => r.code1c),
      ...report.keyMatches.map((m) => m.storedCode),
    ]);
    report.positionsNotInFile = storedCodes
      .filter((c) => !inFile.has(c))
      .sort();
    // Reported when the key keeps a valid row from being written.
    report.keyConflicts = [...new Set(keys.conflicts.values())]
      .filter((c) => c.codes.some((code) => planned.has(code)))
      .map((c) => ({
        ...c,
        lines: [...rowReports.values()]
          .filter((r) => r.code1c !== null && c.codes.includes(r.code1c))
          .map((r) => r.line),
      }));
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
    const toWrite = plans.filter((p) => p.action !== 'unchanged');
    const toProject = new Map<string, number>(); // code_1c → stockId

    for (const p of plans) {
      if (p.action !== 'unchanged') continue;
      rows.get(p.row.line)!.written = 'skipped_unchanged';
      written.skippedUnchanged += 1;
      // Resume path: a batch committed but its projection never ran.
      if (p.existing && !p.existing.hasCatalogPart)
        toProject.set(p.row.code1c, p.existing.stockId);
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
          toProject.set(w.code1c, w.stockId);
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
    // shared mapping. A failure is recorded, not fatal: supply data is
    // committed, and re-running the import re-projects anything missing.
    const lineByCode = new Map(plans.map((p) => [p.row.code1c, p.row.line]));
    for (const [code1c, stockId] of toProject) {
      try {
        await this.projector.projectStock(stockId);
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

  /** Source-side statistics (units, vehicle normalization, look-alikes). */
  private summarizeSource(report: ImportReport, rows: ParsedRow[]): void {
    const mappings = new Map<string, VehicleMappingSummary>();
    for (const r of rows) {
      report.units[r.unit] = (report.units[r.unit] ?? 0) + 1;
      if (r.quantity === null) report.summary.rowsWithoutQuantity += 1;
      if (r.priceScaled) report.summary.rowsWithScaledPrice += 1;
      const v = report.vehicles;
      if (r.vehicle.kind === 'universal') v.universalRows += 1;
      else if (r.vehicle.kind === 'make') v.makeWideRows += 1;
      else {
        v.specificModelRows += 1;
        v.modelLinks += r.vehicle.models.length;
        if (r.vehicle.models.length > 1) v.multiModelRows += 1;
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
      else if (r.outcome === 'conflict') s.rowsInKeyConflict += 1;
      else s.rowsUnchanged += 1;
      if (r.outcome === 'update' && r.changes.includes('price'))
        s.rowsWithPriceChange += 1;
      if (r.outcome === 'update' && r.changes.includes('part_number'))
        s.rowsWithPartNumberChange += 1;
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
    s.rowsMatchedByKey = report.keyMatches.length;
    s.keyConflicts = report.keyConflicts.length;
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
      rowsWithScaledPrice: 0,
      newWithoutCategory: 0,
      existingWithoutCategory: 0,
      rowsWithPartNumberChange: 0,
      duplicateSourceCodes: 0,
      duplicateCodesMaxPrice: 0,
      rowsMerged: 0,
      codesWithoutValidPrice: 0,
      rowsMatchedByKey: 0,
      keyConflicts: 0,
      rowsInKeyConflict: 0,
      rowsToCreateWithSharedKey: 0,
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
      universalRows: 0,
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
    keyMatches: [],
    keyConflicts: [],
    keyShared: [],
    lookAlikes: [],
    positionsNotInFile: [],
    projectionFailures: [],
    rows: [],
  };
}
