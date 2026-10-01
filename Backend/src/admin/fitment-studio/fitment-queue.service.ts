/**
 * FitmentQueueService — the PART-FIRST conveyor behind /v1/admin/fitment.
 *
 * The car-first service (FitmentStudioService) answers "which parts are missing
 * from this vehicle's node?". This one answers the question the initial
 * database push actually asks: "here is a part — which cars does it fit?".
 * Same `fitment_bindings` rows, opposite direction of travel, which is why this
 * is a second service over the same table rather than more options on the old
 * one.
 *
 * Query discipline: the queue is ONE count + ONE findMany that pulls each
 * part's bindings inline (no N+1, no per-row round trip), because the operator
 * pulls 300 rows and then navigates them by arrow key.
 *
 * `filter=top300` is the EXPLICIT business list (top300/fitment-top300.list.ts):
 * exactly those CatalogPart ids, in that order — never a ranking derived from
 * sales, ratings or `fitment_priority`, and never padded with other parts.
 */

import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { NodeCategory, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { BindPartFitmentDto } from './dto/bind-part-fitment.dto';
import { GetPartsQueueQueryDto } from './dto/get-parts-queue-query.dto';
import {
  isCategoryAllowedOnNode,
  suggestedNodeFor,
} from './fitment-node.config';
import { FITMENT_TOP300_PART_IDS } from './top300/fitment-top300.list';
import {
  FITMENT_TOP300_LIST,
  Top300Report,
  sortByTop300,
  top300Positions,
  validateTop300List,
} from './top300/top300-list';

/** Node order used to pick ONE `nodeKey` for a part bound at several nodes. */
const NODE_ORDER: NodeCategory[] = [
  NodeCategory.ENGINE,
  NodeCategory.FRONT_BRAKES,
  NodeCategory.REAR_BRAKES,
  NodeCategory.SUSPENSION,
  NodeCategory.TRANSMISSION,
  NodeCategory.ELECTRICAL,
  NodeCategory.EXHAUST,
];

const queueSelect = {
  id: true,
  title: true,
  images: true,
  oemNumbers: true,
  gmNumbers: true,
  isOem: true,
  fitmentPriority: true,
  brand: { select: { name: true } },
  category: {
    select: { slug: true, parent: { select: { slug: true } } },
  },
  fitmentBindings: {
    select: { vehicleModelId: true, node: { select: { category: true } } },
  },
} satisfies Prisma.CatalogPartSelect;

type QueueRow = Prisma.CatalogPartGetPayload<{ select: typeof queueSelect }>;

/** What `filter=top300` reports about the explicit list (meta.top300). */
export interface Top300QueueMeta {
  listSize: number;
  targetSize: number;
  /** Listed ids that exist in the catalog. */
  resolved: number;
  /** Listed ids with no CatalogPart — reported, never substituted. */
  missing: string[];
  duplicates: string[];
  invalid: string[];
}

export interface PartsQueueResponse {
  data: ReturnType<FitmentQueueService['mapRow']>[];
  /** `top300` is present only for filter=top300 (additive to `total`). */
  meta: { total: number; top300?: Top300QueueMeta };
}

@Injectable()
export class FitmentQueueService {
  private readonly logger = new Logger(FitmentQueueService.name);
  /** The validated explicit TOP-300 list (first occurrence of each id). */
  private readonly top300: Top300Report;
  private readonly top300Rank: Map<string, number>;

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(FITMENT_TOP300_LIST)
    top300List: readonly unknown[] = FITMENT_TOP300_PART_IDS,
  ) {
    this.top300 = validateTop300List(top300List);
    this.top300Rank = top300Positions(this.top300.ids);
    // The CI spec rejects these for the shipped list; an injected list that
    // still carries them is used (first occurrence wins) but never silently.
    if (this.top300.duplicates.length || this.top300.invalid.length) {
      this.logger.warn(
        `TOP-300 list: ${this.top300.duplicates.length} duplicate and ` +
          `${this.top300.invalid.length} invalid entr(y/ies) ignored — run ` +
          '`npm run fitment:top300 -- --dry-run`.',
      );
    }
  }

  /**
   * The conveyor. For `all` / `unmapped` the ordering is [fitmentPriority asc
   * (nulls last), id asc]; for `top300` it is the explicit list's order. Both
   * are stable — the operator builds muscle memory on row position, so a queue
   * that reshuffles between fetches is worse than a slow one.
   */
  async getPartsQueue(q: GetPartsQueueQueryDto): Promise<PartsQueueResponse> {
    if (q.filter === 'top300') return this.getTop300Queue(q);

    const where = this.queueWhere(q);

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.catalogPart.count({ where }),
      this.prisma.catalogPart.findMany({
        where,
        select: queueSelect,
        orderBy: [
          { fitmentPriority: { sort: 'asc', nulls: 'last' } },
          { id: 'asc' },
        ],
        take: q.limit,
      }),
    ]);

    return {
      data: (rows as QueueRow[]).map((r) => this.mapRow(r)),
      meta: { total },
    };
  }

  /**
   * `filter=top300`: exactly the explicit list, in list order.
   *
   * Two reads in one transaction: which listed ids exist at all (so a missing
   * id is REPORTED in `meta.top300.missing`, never replaced by another part),
   * and the rows themselves (narrowed by `search`, if any). Ordering is applied
   * in memory from the list — independent of sales, ratings, fitment state or
   * whatever order the database returns.
   */
  private async getTop300Queue(
    q: GetPartsQueueQueryDto,
  ): Promise<PartsQueueResponse> {
    const ids = this.top300.ids;
    const report = (resolved: number, missing: string[]): Top300QueueMeta => ({
      listSize: ids.length,
      targetSize: this.top300.targetSize,
      resolved,
      missing,
      duplicates: this.top300.duplicates.map((e) => e.identifier),
      invalid: this.top300.invalid.map((e) => e.identifier),
    });
    if (ids.length === 0) {
      return { data: [], meta: { total: 0, top300: report(0, []) } };
    }

    const inList: Prisma.CatalogPartWhereInput = { id: { in: ids } };
    const search = this.searchWhere(q.search);
    const [present, rows] = await this.prisma.$transaction([
      this.prisma.catalogPart.findMany({
        where: inList,
        select: { id: true },
      }),
      this.prisma.catalogPart.findMany({
        where: search ? { AND: [inList, search] } : inList,
        select: queueSelect,
      }),
    ]);

    const found = new Set((present as { id: string }[]).map((p) => p.id));
    const ordered = sortByTop300(rows as QueueRow[], this.top300Rank);
    return {
      data: ordered.slice(0, q.limit).map((r) => this.mapRow(r)),
      meta: {
        total: ordered.length,
        top300: report(
          found.size,
          ids.filter((id) => !found.has(id)),
        ),
      },
    };
  }

  /**
   * Bind one part to many vehicles at one node.
   *
   * REPLACE, not append: the part-first UI has no per-model unbind, so the set
   * the client sends is the truth for this (part, node) and anything missing
   * from it is deleted — an EMPTY set clears this node for the part (its other
   * nodes are untouched). All-or-nothing in one transaction — the client rolls
   * an optimistic row back on failure, and a partial write would make that
   * rollback a lie.
   *
   * Concurrency: two binds for the same part would otherwise interleave their
   * delete and insert (A deletes, B deletes, A inserts, B inserts) and leave the
   * UNION of both sets — neither operator's answer. The transaction first takes
   * a row lock on the part (`SELECT … FOR UPDATE`), so binds of one part run one
   * after another and the final set is exactly the last committed request's
   * (last-write-wins), never a mix.
   */
  async bindPart(dto: BindPartFitmentDto) {
    const [node, part] = await Promise.all([
      this.prisma.vehicleNode.findUnique({
        where: { category: dto.nodeKey },
        select: { id: true, category: true },
      }),
      this.prisma.catalogPart.findUnique({
        where: { id: dto.partId },
        select: {
          id: true,
          oemNumbers: true,
          gmNumbers: true,
          category: {
            select: { slug: true, parent: { select: { slug: true } } },
          },
        },
      }),
    ]);

    if (!node) {
      // The 7 nodes are seeded once (seedFitmentNodes). Say so, rather than
      // letting the FK blow up as a 500 three lines later.
      throw new NotFoundException(
        `Vehicle node ${dto.nodeKey} is not seeded. Run the fitment node seed.`,
      );
    }
    if (!part) throw new NotFoundException(`Part ${dto.partId} not found`);

    const slug = part.category?.slug ?? null;
    const rootSlug = part.category?.parent?.slug ?? slug;
    if (!isCategoryAllowedOnNode(node.category, slug, rootSlug)) {
      throw new BadRequestException(
        `Category "${slug}" cannot be bound to ${node.category}.`,
      );
    }

    // Every model id must exist: a typo'd id would otherwise fail the FK
    // mid-transaction and surface as a 500 the operator cannot act on.
    const ids = dto.vehicleModelIds;
    if (ids.length > 0) {
      const known = await this.prisma.vehicleModelRef.findMany({
        where: { id: { in: ids } },
        select: { id: true },
      });
      if (known.length !== ids.length) {
        const found = new Set(known.map((m) => m.id));
        const missing = ids.filter((id) => !found.has(id));
        throw new BadRequestException(
          `Unknown vehicle model id(s): ${missing.join(', ')}`,
        );
      }
    }

    await this.prisma.$transaction(async (tx) => {
      // Serialise binds of THIS part (see the method doc): every bind takes the
      // same row lock before touching its bindings.
      await tx.$queryRaw`SELECT id FROM catalog_parts WHERE id = ${part.id} FOR UPDATE`;
      await tx.fitmentBinding.deleteMany({
        where: {
          partId: part.id,
          nodeId: node.id,
          ...(ids.length > 0 ? { vehicleModelId: { notIn: ids } } : {}),
        },
      });
      if (ids.length > 0) {
        await tx.fitmentBinding.createMany({
          data: ids.map((vehicleModelId) => ({
            partId: part.id,
            vehicleModelId,
            nodeId: node.id,
          })),
          skipDuplicates: true,
        });
      }
    });

    return {
      partId: part.id,
      boundCount: ids.length,
      // Echoed so the operator can confirm the cross-reference without leaving
      // the queue. GM numbers count: on this catalogue they are the OEM
      // reference for a GM-labelled part.
      oemNumbers: part.oemNumbers.length > 0 ? part.oemNumbers : part.gmNumbers,
    };
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /** filter + search → one Prisma predicate. */
  private queueWhere(q: GetPartsQueueQueryDto): Prisma.CatalogPartWhereInput {
    return {
      ...this.filterWhere(q.filter),
      ...(this.searchWhere(q.search) ?? {}),
    };
  }

  /** Case-insensitive name/brand/id match, exact OEM/GM membership. */
  private searchWhere(raw?: string): Prisma.CatalogPartWhereInput | undefined {
    const search = raw?.trim();
    return search
      ? {
          OR: [
            { title: { contains: search, mode: 'insensitive' } },
            { brand: { name: { contains: search, mode: 'insensitive' } } },
            { oemNumbers: { has: search } },
            { gmNumbers: { has: search } },
            { id: { contains: search, mode: 'insensitive' } },
          ],
        }
      : undefined;
  }

  /** `all` / `unmapped` (top300 has its own path: getTop300Queue). */
  private filterWhere(
    filter: GetPartsQueueQueryDto['filter'],
  ): Prisma.CatalogPartWhereInput {
    // Vehicle-agnostic on purpose: part-first has no vehicle in scope, so
    // "unmapped" means "bound to nothing at all", not "missing from this car".
    if (filter === 'unmapped') return { fitmentBindings: { none: {} } };
    return {};
  }

  private mapRow(r: QueueRow) {
    const slug = r.category?.slug ?? null;
    const rootSlug = r.category?.parent?.slug ?? slug;
    const oem = r.oemNumbers[0] ?? r.gmNumbers[0] ?? null;

    // A part can hold rows at more than one node (nothing forbids it); the UI
    // shows one, so pick deterministically instead of "whatever came back
    // first" — an unstable nodeKey would move the operator's pre-selection
    // between reloads.
    const boundNodes = new Set(r.fitmentBindings.map((b) => b.node.category));
    const nodeKey = NODE_ORDER.find((n) => boundNodes.has(n)) ?? null;

    return {
      id: r.id,
      name: r.title,
      brand: r.brand?.name ?? null,
      // The buyer catalogue has no SKU column — the supply-side `sourceCode`
      // (1C) is not projected onto CatalogPart. Sent as null rather than
      // inventing one; the id is searchable instead.
      sku: null,
      oem,
      oemNumbers: r.oemNumbers.length > 0 ? r.oemNumbers : r.gmNumbers,
      tag: r.isOem || r.oemNumbers.length > 0 ? 'OEM' : 'AFTER',
      category: slug,
      suggestedNodeCategory: suggestedNodeFor(slug, rootSlug),
      imageUrl: r.images[0] ?? null,
      mappedVehicleModelIds: [
        ...new Set(r.fitmentBindings.map((b) => b.vehicleModelId)),
      ],
      nodeKey,
      // 1-based rank in the explicit business TOP-300 list; null when the part
      // is not on it. Additive — clients that do not read it are unaffected.
      top300Position: this.top300Rank.get(r.id) ?? null,
    };
  }
}
