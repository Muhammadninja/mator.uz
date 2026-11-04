/**
 * Driver's Village classification import — orchestration. Applies a prepared
 * classification file (category_id, subcategory_id, vehicle_make,
 * vehicle_model per code_1c) to the positions the price/stock import created.
 * Run explicitly by an operator (npm run drivers-village:classify, dry run by
 * default); the Telegram ingest timer never runs it.
 *
 *   file ──► read + decode ──► parse rows ──► merge per code_1c
 *        ──► plan against the DB (exact code_1c, live category tree)
 *        ──► (dry run: report) / (apply: batched writes ──► projection)
 *
 * The rules live in drivers-village-classification.rules.ts, the report in
 * drivers-village-classification.report.ts. In short: a category
 * is applied only to an unclassified position (or refines a stored category
 * downwards); a category set in Mator is always kept; unknown or
 * contradictory categories change nothing; vehicles are only added; prices,
 * stock, names, photos and catalog settings are never written. Positions are
 * never created. Idempotent: applying the same file again changes nothing.
 */
import { CatalogProjectionService } from '../../catalog/projection/catalog-projection.service';
import {
  DRIVERS_VILLAGE_CATALOG_SELLER_ID,
  IMPORT_LIMITS,
} from './drivers-village.constants';
import {
  groupByCode,
  mapClassificationHeaders,
  parseClassificationRow,
} from './drivers-village-classification';
import {
  emptyClassificationReport,
  groupMessages,
  summarizeClassification,
  type ClassificationPositionReport,
  type ClassificationReport,
} from './drivers-village-classification.report';
import {
  decideCategory,
  decideVehicles,
  type ClassificationTarget,
  type ClassificationWrite,
} from './drivers-village-classification.rules';
import type {
  ClassificationStore,
  ClassificationWritten,
} from './drivers-village-classification.store';
import { checkEnvironment } from './drivers-village-environment';
import { detectRowNumberCodes } from './drivers-village.planner';
import {
  decodeSource,
  detectDelimiter,
  parseDelimited,
  type SourceEncoding,
} from './tsv-reader';

const UNCATEGORIZED_ID = CatalogProjectionService.UNCATEGORIZED_ID;

export interface ClassificationOptions {
  dryRun: boolean;
  encoding?: SourceEncoding;
  /** Defaults to 'drivers-village'. Only tests pass anything else. */
  catalogSellerId?: string;
  batchSize?: number;
}

/** The projection capability the import needs (CatalogProjectionService). */
export interface ClassificationProjector {
  projectClassification(
    stockId: number,
    opts?: { category?: { expected: string } },
  ): Promise<{ partId: string | null; categoryWritten: boolean }>;
}

interface Plan {
  write: ClassificationWrite | null;
  report: ClassificationPositionReport;
}

export class DriversVillageClassificationService {
  constructor(
    private readonly store: ClassificationStore,
    private readonly projector: ClassificationProjector,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  async run(
    bytes: Uint8Array,
    fileName: string,
    options: ClassificationOptions,
  ): Promise<ClassificationReport> {
    const startedAt = new Date();
    const catalogSellerId =
      options.catalogSellerId ?? DRIVERS_VILLAGE_CATALOG_SELLER_ID;
    const report = emptyClassificationReport(
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
    if (bytes.length > IMPORT_LIMITS.maxFileBytes)
      return abort(
        `File is ${bytes.length} bytes; the limit is ${IMPORT_LIMITS.maxFileBytes}.`,
      );
    let decoded: ReturnType<typeof decodeSource>;
    let delimiter: ReturnType<typeof detectDelimiter>;
    let records: ReturnType<typeof parseDelimited>;
    try {
      decoded = decodeSource(bytes, options.encoding);
      delimiter = detectDelimiter(
        decoded.text,
        (cells) => mapClassificationHeaders(cells).errors.length === 0,
      );
      records = delimiter.ok
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
    report.meta.delimiter = delimiter.name;
    const [header, ...data] = records;
    if (!header) return abort('The file has no header row.');
    if (data.length > IMPORT_LIMITS.maxRows)
      return abort(
        `The file has ${data.length} data rows; the limit is ${IMPORT_LIMITS.maxRows}.`,
      );
    const headers = mapClassificationHeaders(header.cells);
    report.headers = {
      columns: header.cells.map((c) => c.trim()),
      mapped: Object.fromEntries(
        Object.entries(headers.index).map(([f, i]) => [
          f,
          header.cells[i].trim(),
        ]),
      ),
      ignored: headers.ignored,
    };
    if (headers.errors.length)
      return abort(`Header problems: ${headers.errors.join(' ')}`);

    // ── 2. Parse, merge per code_1c ─────────────────────────────────────────
    const rows = data.map((r) =>
      parseClassificationRow(r.cells, r.line, headers),
    );
    report.summary.totalRows = rows.length;
    const rowNumbers = detectRowNumberCodes(rows.map((r) => r.code1c));
    if (rowNumbers)
      return abort(
        `code_1c looks like row numbers, not part numbers: ${rowNumbers.distinct} of ${rowNumbers.rows} rows hold distinct whole numbers from ${rowNumbers.min} to ${rowNumbers.max}. Nothing was applied — check that code_1c holds the articles.`,
      );
    report.rejected = rows
      .filter((r) => !r.usable)
      .map((r) => ({
        line: r.line,
        code1c: r.code1c,
        outcome: 'rejected' as const,
        issues: r.issues,
      }));
    report.summary.rejectedRows = report.rejected.length;
    report.vehicleProblems = groupMessages(
      rows.flatMap((r) =>
        r.usable ? r.issues.filter((i) => i.field?.startsWith('vehicle')) : [],
      ),
    );
    const sources = groupByCode(rows);
    report.summary.codes = sources.length;
    const rowIssues = new Map(rows.map((r) => [r.line, r.issues]));

    // ── 3. Environment ──────────────────────────────────────────────────────
    const env = await checkEnvironment(this.store, catalogSellerId);
    report.environment = {
      catalogSeller: env.catalogSeller,
      linkedSellerId: env.linked?.id ?? null,
      linkedSellerStatus: env.linked?.status ?? null,
      linkedSellerType: env.linked?.sellerType ?? null,
      issues: env.issues,
    };

    // ── 4. Plan ──────────────────────────────────────────────────────────────
    const tree = new Map(
      (await this.store.loadCategoryTree()).map((n) => [n.id, n]),
    );
    const targets = env.linked
      ? await this.store.loadTargets(
          env.linked.id,
          sources.map((s) => s.code1c),
        )
      : new Map<string, ClassificationTarget>();
    const plans: Plan[] = [];
    for (const source of sources) {
      const issues = source.lines.flatMap((l) => rowIssues.get(l) ?? []);
      const warn = (code: string, message: string, field = 'code1c') =>
        issues.push({
          line: source.lines[0],
          code1c: source.code1c,
          kind: 'data',
          severity: 'warning',
          code,
          field,
          message,
        });
      const file =
        source.category === 'conflict'
          ? source.pairs[0]
          : (source.category ?? null);
      const target = targets.get(source.code1c);
      if (!target) {
        warn(
          'position_not_found',
          `no Driver's Village position has code_1c "${source.code1c}" — the classification import never creates positions (the price/stock import does)`,
        );
        plans.push({
          write: null,
          report: {
            code1c: source.code1c,
            lines: source.lines,
            outcome: 'not_found',
            stockId: null,
            category: { action: 'none', existing: null, file, planned: null },
            vehicles: { add: [], addMakes: [], clearUniversal: false },
            curatedBindings: 0,
            issues,
          },
        });
        continue;
      }

      const category = decideCategory(source, target, tree);
      const vehicles = decideVehicles(source.vehicles, target);
      if (category.issue) issues.push(category.issue);
      const named = [
        ...source.vehicles.models.map((m) => `${m.make} ${m.model}`),
        ...source.vehicles.makes.map((m) => `${m} (make-wide)`),
      ];
      if (vehicles.clearUniversal)
        warn(
          'universal_cleared',
          `the part was marked universal by the 1C import (from empty vehicle cells); the file names its vehicles (${named.join(', ')}), so it now fits those`,
          'vehicleModel',
        );
      const vehicleWrite =
        vehicles.addModels.length > 0 ||
        vehicles.addMakes.length > 0 ||
        vehicles.clearUniversal;
      if (vehicleWrite && target.curatedBindings > 0)
        warn(
          'curated_fitment_present',
          `the part has ${target.curatedBindings} Fitment Studio binding(s): buyer fitment decisions use those, not these vehicle links (both are kept)`,
          'vehicleModel',
        );
      const write: ClassificationWrite | null =
        category.set || vehicleWrite
          ? {
              code1c: source.code1c,
              stockId: target.stockId,
              productId: target.productId,
              category: category.set
                ? {
                    expectedPartCategory: target.partCategoryId,
                    set: category.set,
                  }
                : null,
              clearUniversal: vehicles.clearUniversal,
              addModels: vehicles.addModels,
              addMakes: vehicles.addMakes,
            }
          : null;
      plans.push({
        write,
        report: {
          code1c: source.code1c,
          lines: source.lines,
          outcome: write ? 'apply' : 'unchanged',
          stockId: target.stockId,
          category: {
            action: category.action,
            existing: category.existing,
            file,
            planned: category.set?.categoryId ?? null,
          },
          vehicles: {
            add: vehicles.addModels.map((m) => `${m.make}|${m.model}`),
            addMakes: vehicles.addMakes,
            clearUniversal: vehicles.clearUniversal,
          },
          curatedBindings: target.curatedBindings,
          issues,
        },
      });
    }
    report.positions = plans.map((p) => p.report);
    summarizeClassification(report);

    if (options.dryRun) return finish();

    // ── 5. Apply ─────────────────────────────────────────────────────────────
    const setupErrors = env.issues.filter((i) => i.severity === 'error');
    if (!env.catalogSeller || !env.linked || setupErrors.length > 0)
      return abort(
        `Setup error — nothing was written: ${setupErrors.map((i) => i.message).join(' ')}`,
      );
    await this.apply(
      report,
      plans.filter((p) => p.write),
      env.linked.id,
      options.batchSize ?? IMPORT_LIMITS.batchSize,
    );
    return finish();
  }

  private async apply(
    report: ClassificationReport,
    plans: Plan[],
    sellerId: number,
    batchSize: number,
  ): Promise<void> {
    const written = {
      positions: 0,
      categoriesWritten: 0,
      categoriesKeptChanged: 0,
      projected: 0,
      projectionFailures: 0,
    };
    report.summary.written = written;
    for (const p of plans) p.report.written = 'not_written';
    const done: { plan: Plan; result: ClassificationWritten }[] = [];

    for (let i = 0; i < plans.length; i += batchSize) {
      const batch = plans.slice(i, i + batchSize);
      try {
        const results = await this.store.applyClassificationBatch(
          sellerId,
          batch.map((p) => p.write!),
        );
        for (const result of results) {
          const plan = batch.find((p) => p.write!.code1c === result.code1c)!;
          plan.report.written = 'applied';
          written.positions += 1;
          done.push({ plan, result });
        }
        this.log(
          `batch ${i / batchSize + 1}: applied ${results.length} position(s) (${i + batch.length}/${plans.length})`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        report.meta.aborted = true;
        report.meta.abortReason = `Batch starting at position ${i + 1} failed and was rolled back: ${message}. Earlier batches are committed; re-run the same file to resume (applied positions plan as unchanged).`;
        break;
      }
    }

    // The catalog side, through the one shared mapping. A category goes to
    // the part only while the part still has the category it had when
    // planning (compare-and-set): an operator's change wins.
    for (const { plan, result } of done) {
      const w = plan.write!;
      const expected =
        w.category && result.categoryWritten
          ? (w.category.expectedPartCategory ?? UNCATEGORIZED_ID)
          : null;
      try {
        const projected = await this.projector.projectClassification(
          w.stockId,
          expected ? { category: { expected } } : {},
        );
        written.projected += 1;
        plan.report.projected = true;
        if (w.category) {
          const applied = result.categoryWritten && projected.categoryWritten;
          plan.report.categoryWritten = applied;
          if (applied) written.categoriesWritten += 1;
          else {
            written.categoriesKeptChanged += 1;
            plan.report.issues.push({
              line: plan.report.lines[0],
              code1c: w.code1c,
              kind: 'data',
              severity: 'warning',
              code: 'category_changed_meanwhile',
              field: 'category',
              message: `the category of this position changed in Mator while the file was applied — that category is kept; the file's "${w.category.set.categoryId}" is not written`,
            });
          }
        }
      } catch (error) {
        written.projectionFailures += 1;
        plan.report.projected = false;
        report.projectionFailures.push({
          code1c: w.code1c,
          stockId: w.stockId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
