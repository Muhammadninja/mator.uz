/**
 * FitmentStudioService — all Prisma access for the 3D Fitment Studio.
 *
 * Query discipline (no N+1):
 *  - getNodes  = 2 queries total (nodes + all bindings for the vehicle),
 *                grouped in memory. Never one query per node.
 *  - unmapped  = 1 count + 1 page query, filtered with a `fitmentBindings.none`
 *                sub-filter so already-bound parts are excluded in SQL.
 *  - bind/unbind recompute only the ONE affected node.
 *
 * Schema mapping (real mator.uz schema — differs from the blueprint):
 *  - CatalogPart { id, title, brand { name }, priceUzs, category { slug },
 *                  oemNumbers String[] }  (there is no sku → null)
 *  - VehicleModelRef { id, name, make { name } }  (no engine dimension)
 *  - FitmentBinding { partId, vehicleModelId, nodeId, status }
 */

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { NodeCategory, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { BindPartDto } from './dto/bind-part.dto';
import { GetUnmappedPartsQueryDto } from './dto/get-unmapped-parts-query.dto';
import { PropagateFitmentDto } from './dto/propagate-fitment.dto';
import { UnbindPartDto } from './dto/unbind-part.dto';
import {
  NODE_ALLOWED_CATEGORIES,
  completionStatus,
  type CompletionStatus,
} from './fitment-node.config';

// Minimal part projection reused across reads. `oemNumbers` is a scalar String[]
// on CatalogPart (NOT a relation), so it comes back as a plain array.
const partSelect = {
  id: true,
  title: true,
  brand: { select: { name: true } },
  priceUzs: true,
  oemNumbers: true,
} satisfies Prisma.CatalogPartSelect;

type PartLite = {
  id: string;
  title: string;
  brand: { name: string } | null;
  priceUzs: Prisma.Decimal;
  oemNumbers: string[];
};

@Injectable()
export class FitmentStudioService {
  constructor(private readonly prisma: PrismaService) {}

  /** Vehicle list for the studio's make/model selectors. The real schema has no
   *  engine string on the model ref, so `engine` is always '' (binding is
   *  model-level). */
  async listVehicles() {
    const rows = await this.prisma.vehicleModelRef.findMany({
      select: { id: true, name: true, make: { select: { name: true } } },
      orderBy: [{ make: { name: 'asc' } }, { name: 'asc' }],
    });
    return rows.map((r) => ({
      id: r.id,
      make: r.make.name,
      model: r.name,
      engine: '',
    }));
  }

  /** All 7 nodes for a vehicle with counts, completion status, and the mapped
   *  parts (so the studio can render bound chips without a second round-trip). */
  async getNodes(vehicleModelId: string) {
    await this.assertVehicle(vehicleModelId);

    const [nodes, bindings] = await this.prisma.$transaction([
      this.prisma.vehicleNode.findMany({ orderBy: { category: 'asc' } }),
      this.prisma.fitmentBinding.findMany({
        where: { vehicleModelId },
        select: { nodeId: true, status: true, part: { select: partSelect } },
      }),
    ]);

    const byNode = new Map<string, typeof bindings>();
    for (const b of bindings) {
      if (!b.nodeId) continue;
      const list = byNode.get(b.nodeId) ?? [];
      list.push(b);
      byNode.set(b.nodeId, list);
    }

    return nodes.map((n) => {
      const list = byNode.get(n.id) ?? [];
      const hasOem = list.some((b) => (b.part as PartLite).oemNumbers.length > 0);
      const status: CompletionStatus = completionStatus(list.length, hasOem);
      return {
        id: n.id,
        category: n.category,
        name: n.name,
        position: { x: n.positionX, y: n.positionY, z: n.positionZ },
        totalMappedParts: list.length,
        completionStatus: status,
        parts: list.map((b) => this.mapPart(b.part as PartLite, b.status)),
      };
    });
  }

  /** Catalogue parts NOT yet bound to this vehicle (+ node), filtered by the
   *  node category's allowed catalogue categories, searchable, paged. */
  async getUnmappedParts(q: GetUnmappedPartsQueryDto) {
    await this.assertVehicle(q.vehicleModelId);

    // Resolve the node for the given category so we can exclude parts already
    // bound to THIS vehicle+node (not merely to the vehicle).
    let nodeId: string | undefined;
    let allowedSlugs: string[] | undefined;
    if (q.nodeCategory) {
      const node = await this.prisma.vehicleNode.findUnique({
        where: { category: q.nodeCategory },
        select: { id: true },
      });
      nodeId = node?.id;
      allowedSlugs = NODE_ALLOWED_CATEGORIES[q.nodeCategory];
    }

    const search = q.search?.trim();
    const where: Prisma.CatalogPartWhereInput = {
      fitmentBindings: {
        none: nodeId
          ? { vehicleModelId: q.vehicleModelId, nodeId }
          : { vehicleModelId: q.vehicleModelId },
      },
      ...(allowedSlugs ? { category: { slug: { in: allowedSlugs } } } : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: 'insensitive' } },
              { oemNumbers: { has: search } },
            ],
          }
        : {}),
    };

    const skip = (q.page - 1) * q.limit;
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.catalogPart.count({ where }),
      this.prisma.catalogPart.findMany({
        where,
        select: partSelect,
        orderBy: { title: 'asc' },
        skip,
        take: q.limit,
      }),
    ]);

    return {
      data: (rows as PartLite[]).map((p) => this.mapPart(p)),
      meta: {
        page: q.page,
        limit: q.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / q.limit)),
      },
    };
  }

  /** Create-or-update a fitment. Validates the category guard, echoes OEM refs.
   *  The wire field is `productId` but it maps to `partId` in the binding. */
  async bind(dto: BindPartDto) {
    const [node, part] = await Promise.all([
      this.prisma.vehicleNode.findUnique({ where: { id: dto.nodeId } }),
      this.prisma.catalogPart.findUnique({
        where: { id: dto.productId },
        select: { category: { select: { slug: true } }, ...partSelect },
      }),
    ]);
    if (!node) throw new NotFoundException(`Node ${dto.nodeId} not found`);
    if (!part) throw new NotFoundException(`Part ${dto.productId} not found`);
    await this.assertVehicle(dto.vehicleModelId);

    // Category guard: block KNOWN mismatches (e.g. "oils" → FRONT_BRAKES). If the
    // part's category can't be resolved to a slug, we allow (can't validate).
    const slug = (part as { category?: { slug?: string | null } }).category?.slug;
    const allowed = NODE_ALLOWED_CATEGORIES[node.category as NodeCategory];
    if (slug && !allowed.includes(slug)) {
      throw new BadRequestException(
        `Category "${slug}" cannot be bound to node ${node.category}. Allowed: ${allowed.join(', ')}.`,
      );
    }

    await this.prisma.fitmentBinding.upsert({
      where: {
        partId_vehicleModelId_nodeId: {
          partId: dto.productId,
          vehicleModelId: dto.vehicleModelId,
          nodeId: dto.nodeId,
        },
      },
      create: {
        partId: dto.productId,
        vehicleModelId: dto.vehicleModelId,
        nodeId: dto.nodeId,
        status: dto.status ?? 'EXACT_MATCH',
      },
      update: { status: dto.status ?? undefined },
    });

    return {
      node: await this.nodeStatus(dto.vehicleModelId, dto.nodeId),
      oemNumbers: (part as PartLite).oemNumbers,
    };
  }

  /** Remove one fitment. Idempotent (deleteMany → no throw when absent). */
  async unbind(dto: UnbindPartDto) {
    await this.prisma.fitmentBinding.deleteMany({
      where: {
        partId: dto.productId,
        vehicleModelId: dto.vehicleModelId,
        nodeId: dto.nodeId,
      },
    });
    return { node: await this.nodeStatus(dto.vehicleModelId, dto.nodeId) };
  }

  /** Copy every binding of one node from a source model onto target models. */
  async propagateNode(dto: PropagateFitmentDto) {
    const source = await this.prisma.fitmentBinding.findMany({
      where: { vehicleModelId: dto.sourceVehicleModelId, nodeId: dto.nodeId },
      select: { partId: true, status: true },
    });
    if (source.length === 0) {
      return { copied: 0, sourceCount: 0, targets: dto.targetVehicleModelIds.length };
    }

    const results = await this.prisma.$transaction(
      dto.targetVehicleModelIds.map((targetId) =>
        this.prisma.fitmentBinding.createMany({
          data: source.map((s) => ({
            partId: s.partId,
            vehicleModelId: targetId,
            nodeId: dto.nodeId,
            status: s.status,
          })),
          skipDuplicates: true,
        }),
      ),
    );

    return {
      copied: results.reduce((a, r) => a + r.count, 0),
      sourceCount: source.length,
      targets: dto.targetVehicleModelIds.length,
    };
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private async nodeStatus(vehicleModelId: string, nodeId: string) {
    const list = await this.prisma.fitmentBinding.findMany({
      where: { vehicleModelId, nodeId },
      select: { part: { select: { oemNumbers: true } } },
    });
    const hasOem = list.some(
      (b) => (b.part as { oemNumbers: string[] }).oemNumbers.length > 0,
    );
    return {
      id: nodeId,
      totalMappedParts: list.length,
      completionStatus: completionStatus(list.length, hasOem),
    };
  }

  private async assertVehicle(vehicleModelId: string) {
    const exists = await this.prisma.vehicleModelRef.findUnique({
      where: { id: vehicleModelId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException(`Vehicle model ${vehicleModelId} not found`);
  }

  private mapPart(p: PartLite, status?: string) {
    return {
      id: p.id,
      name: p.title,
      brand: p.brand?.name ?? null,
      sku: null,
      price: Number(p.priceUzs),
      oem: p.oemNumbers[0] ?? null,
      oemNumbers: p.oemNumbers,
      tag: p.oemNumbers.length > 0 ? 'OEM' : 'AFTER',
      ...(status ? { status } : {}),
    };
  }
}
