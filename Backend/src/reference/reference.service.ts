import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../redis/cache.service';
import { RedisKeys } from '../redis/redis.keys';

/**
 * Shared TTL for every reference-catalog cache entry. Reference data changes
 * extremely rarely (a re-seed), so a long TTL is safe and TTL expiry is the only
 * invalidation mechanism (no pub/sub, no event handlers). One constant so TTLs
 * are never hardcoded per call site.
 */
export const REFERENCE_CACHE_TTL = 24 * 60 * 60; // 24h, in seconds

/**
 * Buyer Reference API — read-only access to the seeded reference catalog
 * (makes → models → trims → engines). No hardcoded arrays: every list comes
 * straight from the reference tables, ordered by the `sortOrder` seeded from the
 * frontend catalog so the API order matches the frontend order exactly.
 *
 * The list reads are cached read-through via {@link CacheService.remember}
 * (TTL-only invalidation). Validation (400 on a missing param, 404 on an unknown
 * id) is deliberately NOT cached, so error behaviour is byte-identical to the
 * uncached path — only the successful DB list read is served from cache.
 *
 * This service creates nothing and mutates nothing.
 */
/** The synthetic fallback bucket — never surfaced to the buyer, at any level. */
const UNCATEGORIZED_ID = 'cat_uncategorized';

@Injectable()
export class ReferenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  /**
   * Public part-category children. Pass `parentId` to list the active children of
   * that node (e.g. the "Другое"/OTHER root's id → its oil sub-buckets); omit it
   * for the active roots. Only ACTIVE categories are ever returned, at any level,
   * and the synthetic Uncategorized bucket is never surfaced.
   *
   * Unlike the make/model reference lists this is NOT cached: categories are
   * admin-editable and every admin write must take effect on the next read (the
   * same "no stale categories" contract the buyer grid follows).
   *
   * `parentId` unknown → 404; an empty `items` on a known leaf is a normal 200.
   * `level` is derived from the parent chain (there is no stored column). The
   * node ships camelCase (`parentId`, `sortOrder`) to match the frontend contract.
   */
  async listCategories(parentId?: string) {
    const wanted = parentId && parentId.trim() ? parentId.trim() : null;

    const rows = await this.prisma.partCategory.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
        parentId: true,
        sortOrder: true,
        isActive: true,
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    const byId = new Map(rows.map((r) => [r.id, r]));

    if (wanted !== null && !byId.has(wanted)) {
      throw new NotFoundException('Unknown parentId');
    }

    // Depth from the root, memoized, with a cycle guard (the admin move endpoint
    // already prevents cycles, but a read must never loop on bad data).
    const levelCache = new Map<string, number>();
    const levelOf = (id: string): number => {
      const cached = levelCache.get(id);
      if (cached !== undefined) return cached;
      let depth = 0;
      let cur = byId.get(id);
      const seen = new Set<string>();
      while (cur?.parentId && byId.has(cur.parentId) && !seen.has(cur.id)) {
        seen.add(cur.id);
        depth += 1;
        cur = byId.get(cur.parentId);
      }
      levelCache.set(id, depth);
      return depth;
    };

    const items = rows
      .filter(
        (r) =>
          (r.parentId ?? null) === wanted &&
          r.isActive &&
          r.id !== UNCATEGORIZED_ID,
      )
      // Sort here rather than trust the query order: siblings order by sortOrder,
      // ties by name (the same order the admin tree uses).
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      .map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        parentId: r.parentId,
        level: levelOf(r.id),
        sortOrder: r.sortOrder,
      }));

    return { items, total: items.length };
  }

  /** All vehicle makes, in frontend catalog order. */
  async listMakes() {
    return this.cache.remember(RedisKeys.cacheReferenceMakes(), REFERENCE_CACHE_TTL, async () => {
      const makes = await this.prisma.vehicleMake.findMany({
        where: { isActive: true },
        orderBy: { sortOrder: 'asc' },
        select: { id: true, name: true, logoUrl: true, comingSoon: true },
      });
      return {
        items: makes.map((m) => ({
          id: m.id,
          name: m.name,
          logo_url: m.logoUrl,
          coming_soon: m.comingSoon,
        })),
        total: makes.length,
      };
    });
  }

  /**
   * Models for a make, in frontend catalog order.
   * 400 if makeId is missing/blank (required query param); 404 if it is unknown.
   * Validating here keeps a missing param from reaching Prisma (which would
   * otherwise throw a validation error surfaced as a 500).
   */
  async listModels(makeId: string) {
    if (!makeId) throw new BadRequestException('makeId is required');

    const make = await this.prisma.vehicleMake.findUnique({ where: { id: makeId } });
    if (!make) throw new NotFoundException('Unknown make_id');

    return this.cache.remember(
      RedisKeys.cacheReferenceModels(makeId),
      REFERENCE_CACHE_TTL,
      async () => {
        const models = await this.prisma.vehicleModelRef.findMany({
          // Hide every model of an inactive brand — models have no active flag
          // of their own, so the parent make's isActive gates them.
          where: { makeId, make: { isActive: true } },
          orderBy: { sortOrder: 'asc' },
          select: { id: true, makeId: true, name: true },
        });
        return {
          items: models.map((m) => ({ id: m.id, make_id: m.makeId, name: m.name })),
          total: models.length,
        };
      },
    );
  }

  /**
   * Trims for a model, in frontend catalog order.
   * 400 if modelId is missing/blank (required query param); 404 if it is unknown.
   */
  async listTrims(modelId: string) {
    if (!modelId) throw new BadRequestException('modelId is required');

    const model = await this.prisma.vehicleModelRef.findUnique({ where: { id: modelId } });
    if (!model) throw new NotFoundException('Unknown model_id');

    return this.cache.remember(
      RedisKeys.cacheReferenceTrims(modelId),
      REFERENCE_CACHE_TTL,
      async () => {
        const trims = await this.prisma.vehicleTrim.findMany({
          where: { modelId },
          orderBy: { sortOrder: 'asc' },
          select: { id: true, modelId: true, name: true },
        });
        return {
          items: trims.map((t) => ({ id: t.id, model_id: t.modelId, name: t.name })),
          total: trims.length,
        };
      },
    );
  }

  /**
   * Engines, in frontend catalog order.
   *
   * `trimId` is OPTIONAL and currently performs EXISTENCE VALIDATION ONLY:
   * when supplied, the trim must exist (404 otherwise), but the full engine list
   * is still returned. Engine filtering by trim is NOT available because the
   * backend schema intentionally does not store trim→engine relationships (the
   * frontend `VehicleTrim.engineIds` M:N has no schema column — see the
   * "Year-based fitment / Do NOT change" architecture decision).
   *
   * TODO: Filtering by trimId will become available once trim↔engine
   * relationships are introduced into the reference catalog. Until then this
   * parameter only validates existence. See docs/REFERENCE_DATA_GAPS.md
   * ("VehicleTrim.engineIds").
   */
  async listEngines(trimId?: string) {
    if (trimId) {
      const trim = await this.prisma.vehicleTrim.findUnique({ where: { id: trimId } });
      if (!trim) throw new NotFoundException('Unknown trim_id');
    }

    // The engine list does not vary by trimId (trimId only validates existence
    // above), so a single cache key serves every call.
    return this.cache.remember(
      RedisKeys.cacheReferenceEngines(),
      REFERENCE_CACHE_TTL,
      async () => {
        const engines = await this.prisma.vehicleEngine.findMany({
          orderBy: { sortOrder: 'asc' },
          select: { id: true, name: true, displacementCc: true, fuelType: true },
        });
        return {
          items: engines.map((e) => ({
            id: e.id,
            name: e.name,
            displacement_cc: e.displacementCc,
            fuel_type: e.fuelType ? e.fuelType.toLowerCase() : null,
          })),
          total: engines.length,
        };
      },
    );
  }
}
