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
 */

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { NodeCategory, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { BindPartFitmentDto } from './dto/bind-part-fitment.dto';
import { GetPartsQueueQueryDto } from './dto/get-parts-queue-query.dto';
import {
  isCategoryAllowedOnNode,
  suggestedNodeFor,
} from './fitment-node.config';

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

@Injectable()
export class FitmentQueueService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The conveyor. Ordering is [fitmentPriority asc (nulls last), id asc] and is
   * the SAME for every filter — the operator builds muscle memory on row
   * position, so a queue that reshuffles between fetches is worse than a slow
   * one.
   */
  async getPartsQueue(q: GetPartsQueueQueryDto) {
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
    const search = q.search?.trim();
    const searchWhere: Prisma.CatalogPartWhereInput | undefined = search
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

    return { ...this.filterWhere(q.filter), ...(searchWhere ?? {}) };
  }

  private filterWhere(
    filter: GetPartsQueueQueryDto['filter'],
  ): Prisma.CatalogPartWhereInput {
    if (filter === 'all') return {};
    // Vehicle-agnostic on purpose: part-first has no vehicle in scope, so
    // "unmapped" means "bound to nothing at all", not "missing from this car".
    if (filter === 'unmapped') return { fitmentBindings: { none: {} } };

    // top300: the business TOP-300 exactly as already ranked in the database —
    // every part with a stored `fitment_priority` (1 = first), in that order
    // (see getPartsQueue). Read as stored: nothing here recomputes a rank from
    // sales or ratings, and nothing is substituted when no part is ranked (the
    // tab is then empty rather than silently showing other parts).
    return { fitmentPriority: { not: null } };
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
    };
  }
}
