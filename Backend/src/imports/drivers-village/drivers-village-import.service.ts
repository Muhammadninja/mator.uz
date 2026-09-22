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
 *   • Batched: each batch is one transaction — all of its positions or none.
 *     A failed batch stops the run; committed batches stand, and re-running the
 *     same file resumes (committed rows plan as unchanged, missing
 *     projections are re-done).
 *   • Explicit seller: positions belong to the BUSINESS supply-side seller
 *     linked to the catalog dealer 'drivers-village' (sellers.catalog_seller_id,
 *     tg_id NULL). The importer never creates a seller; a missing or
 *     non-BUSINESS link is a setup error that blocks the import.
 *   • Exact price: the file's price is written to Stock.priceUzs and projected
 *     to CatalogPart.priceUzs verbatim — no markup, no retail conversion, no
 *     rounding (see drivers-village-row.parser.ts).
 */
import { createHash } from 'crypto';
import {
  DRIVERS_VILLAGE_CATALOG_SELLER_ID,
  DRIVERS_VILLAGE_SOURCE_SYSTEM,
  IMPORT_LIMITS,
} from './drivers-village.constants';
import { mapHeaders, parseRow } from './drivers-village-row.parser';
import {
  buildWrite,
  diffPosition,
  findLookAlikes,
  resolveCategories,
} from './drivers-village.planner';
import type {
  ImportReport,
  RowReport,
  VehicleMappingSummary,
} from './drivers-village.report';
import {
  REQUIRED_MIGRATION,
  type DriversVillageStore,
} from './drivers-village.store';
import type {
  ExistingPosition,
  ImportIssue,
  ParsedRow,
  RowPlan,
} from './drivers-village.types';
import { decodeSource, parseTsv, type SourceEncoding } from './tsv-reader';

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
    let parsedRecords: ReturnType<typeof parseTsv>;
    try {
      decoded = decodeSource(bytes, options.encoding);
      parsedRecords = parseTsv(decoded.text);
    } catch (error) {
      return abort(
        `Cannot read the file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    report.meta.encoding = decoded.encoding;
    report.meta.encodingDetected = decoded.detected;
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
    };
    if (headers.errors.length)
      return abort(`Header problems: ${headers.errors.join(' ')}`);

    // ── 2. Parse ─────────────────────────────────────────────────────────────
    const rowReports = new Map<number, RowReport>();
    const parsed: ParsedRow[] = [];
    for (const rec of records) {
      const result = parseRow(rec.cells, rec.line, headers);
      rowReports.set(rec.line, {
        line: rec.line,
        code1c: result.code1c,
        outcome: result.row ? 'create' : 'rejected',
        changes: [],
        issues: result.issues,
      });
      if (result.row) parsed.push(result.row);
    }
    report.summary.totalRows = records.length;

    // Duplicate code_1c: every occurrence is rejected — picking one would be a
    // silent choice between two different positions.
    const byCode = new Map<string, number[]>();
    for (const r of rowReports.values()) {
      if (r.code1c)
        byCode.set(r.code1c, [...(byCode.get(r.code1c) ?? []), r.line]);
    }
    const duplicateCodes = [...byCode].filter(([, lines]) => lines.length > 1);
    report.summary.duplicateSourceCodes = duplicateCodes.length;
    const duplicateLines = new Set(
      duplicateCodes.flatMap(([, lines]) => lines),
    );
    for (const [code, lines] of duplicateCodes) {
      for (const line of lines) {
        const r = rowReports.get(line)!;
        r.outcome = 'rejected';
        r.issues.push({
          line,
          code1c: code,
          kind: 'data',
          severity: 'error',
          code: 'duplicate_code_1c',
          field: 'code1c',
          message: `code_1c "${code}" appears on lines ${lines.join(', ')}`,
        });
      }
    }
    const valid = parsed.filter((r) => !duplicateLines.has(r.line));
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
          `This database does not have migration ${REQUIRED_MIGRATION} yet (run \`npx prisma migrate deploy\`). Existing positions cannot be read, so every valid row is planned as a create.`,
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
    const tree = new Map(
      (await this.store.loadCategories()).map((c) => [c.id, c]),
    );
    report.environment.categoriesInDatabase = tree.size;

    // ── 4. Plan ──────────────────────────────────────────────────────────────
    const existing = linked
      ? await this.store.loadPositions(
          linked.id,
          valid.map((r) => r.code1c),
        )
      : new Map<string, ExistingPosition>();
    const missingIds = new Set<string>();
    const plans: RowPlan[] = [];
    for (const row of valid) {
      const rr = rowReports.get(row.line)!;
      const cats = resolveCategories(row, tree);
      rr.issues.push(...cats.issues);
      if (!cats.write) {
        rr.outcome = 'blocked';
        for (const id of [row.categoryId, row.subcategoryId])
          if (!tree.has(id)) missingIds.add(id);
        continue;
      }
      const write = buildWrite(row, cats.write);
      const prev = existing.get(row.code1c) ?? null;
      const changes = prev ? diffPosition(write, prev) : [];
      const action = !prev ? 'create' : changes.length ? 'update' : 'unchanged';
      rr.outcome = action;
      rr.changes = changes;
      rr.price = { from: prev?.priceUzs ?? null, to: write.priceUzs };
      rr.quantity = { from: prev?.quantity ?? null, to: write.quantity };
      plans.push({ row, action, write, changes, existing: prev });
    }
    report.environment.missingCategoryIds = [...missingIds].sort();
    report.summary.existingPositionsWithPhotos = [...existing.values()].filter(
      (p) => p.imageCount > 0,
    ).length;
    if (linked) {
      const inFile = new Set([...rowReports.values()].map((r) => r.code1c));
      report.positionsNotInFile = (
        await this.store.loadAllSourceCodes(linked.id)
      )
        .filter((c) => !inFile.has(c))
        .sort();
    }
    report.rows = [...rowReports.values()].sort((a, b) => a.line - b.line);
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
      else if (r.outcome === 'blocked') s.blockedRows += 1;
      else if (r.outcome === 'create') s.rowsToCreate += 1;
      else if (r.outcome === 'update') s.rowsToUpdate += 1;
      else s.rowsUnchanged += 1;
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
    s.lookAlikeGroups = report.lookAlikes.length;
    s.positionsNotInFile = report.positionsNotInFile.length;
  }
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
      catalogSellerId,
      sourceSystem: DRIVERS_VILLAGE_SOURCE_SYSTEM,
      currency: 'UZS',
      startedAt: startedAt.toISOString(),
      finishedAt: '',
      durationMs: 0,
      aborted: false,
      abortReason: null,
    },
    headers: { columns: [], mapped: {}, ignored: [] },
    environment: {
      catalogSeller: null,
      linkedSellerId: null,
      linkedSellerStatus: null,
      linkedSellerType: null,
      categoriesInDatabase: 0,
      missingCategoryIds: [],
      issues: [],
    },
    summary: {
      totalRows: 0,
      validRows: 0,
      rejectedRows: 0,
      blockedRows: 0,
      rowsToCreate: 0,
      rowsToUpdate: 0,
      rowsUnchanged: 0,
      duplicateSourceCodes: 0,
      dataErrors: 0,
      dataWarnings: 0,
      referenceErrors: 0,
      referenceWarnings: 0,
      lookAlikeGroups: 0,
      positionsNotInFile: 0,
      existingPositionsWithPhotos: 0,
      written: null,
    },
    vehicles: {
      universalRows: 0,
      makeWideRows: 0,
      specificModelRows: 0,
      multiModelRows: 0,
      modelLinks: 0,
      mappings: [],
    },
    units: {},
    lookAlikes: [],
    positionsNotInFile: [],
    projectionFailures: [],
    rows: [],
  };
}
