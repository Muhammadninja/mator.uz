import { Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  PartMainCategory,
  PartVehicleCategory,
  PartOriginRegion,
  ProductKind,
  OilType,
} from '@prisma/client';
import { OIL_TYPE_LABELS, formatVolume } from '../../common/motor-oil.util';
import { MAIN_CATEGORY_TO_SLUG } from '../categories/category-map';
import { PrismaService } from '../../prisma/prisma.service';
import { clampLimit } from '../../common/pagination.util';
import {
  ListPartsQueryDto,
  KIND_BY_WIRE,
  OIL_TYPE_BY_WIRE,
} from './dto/list-parts.query.dto';
import {
  PART_INCLUDE,
  PartWithRelations,
  presentPartItem,
  computeCompatibility,
  VehicleCompatContext,
} from './part.presenter';
import { ActiveSale, DiscountResult, DiscountService } from '../../sales/discount.service';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// Wire market names → PartOriginRegion enum.
const REGION_BY_WIRE: Record<string, PartOriginRegion> = {
  china: PartOriginRegion.CHINA,
  europe: PartOriginRegion.EUROPE,
  russia: PartOriginRegion.RUSSIA,
  korea: PartOriginRegion.KOREA,
  usa: PartOriginRegion.USA,
  japan: PartOriginRegion.JAPAN,
};

const MAIN_CATEGORY_VALUES = new Set(Object.values(PartMainCategory));
const VEHICLE_CATEGORY_VALUES = new Set(Object.values(PartVehicleCategory));

/** Garage-vehicle context for compatibility: trim/engine (fine) + make/model names. */
interface VehicleFilterContext extends VehicleCompatContext {
  makeName: string | null;
  modelName: string | null;
}

/** Shared Prisma select for the vehicle fields a compatibility check needs —
 *  used by both the by-id and by-VIN lookups so they stay in lockstep. */
const VEHICLE_CONTEXT_SELECT = {
  trimId: true,
  engineId: true,
  year: true,
  make: { select: { name: true } },
  model: { select: { name: true } },
} satisfies Prisma.VehicleSelect;

type VehicleContextRow = Prisma.VehicleGetPayload<{
  select: typeof VEHICLE_CONTEXT_SELECT;
}>;

function mapVehicleContext(v: VehicleContextRow): VehicleFilterContext {
  return {
    trimId: v.trimId,
    engineId: v.engineId,
    year: v.year,
    makeName: v.make?.name ?? null,
    modelName: v.model?.name ?? null,
  };
}

@Injectable()
export class PartsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly discounts: DiscountService,
  ) {}

  /** Price one part against a pre-loaded snapshot of the active sales. */
  private discountFor(
    part: PartWithRelations,
    sales: ActiveSale[],
  ): DiscountResult {
    return this.discounts.calculateDiscount(
      Number(part.priceUzs),
      { id: part.id, categoryId: part.categoryId, sellerId: part.sellerId },
      sales,
    );
  }

  async list(query: ListPartsQueryDto) {
    const vehicle = await this.loadVehicle(query.vehicle_id);
    const where = this.buildWhere(query, vehicle);
    const rollup = this.rollupMainCategory(query);
    // A macro-category rollup defaults to bestseller-first; an explicit sort wins.
    const effectiveSort = query.sort ?? (rollup ? 'bestseller' : undefined);
    const page = query.page ?? 1;
    const pageSize = clampLimit(
      query.page_size,
      DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );

    const [total, items, brandFacet, priceAgg] = await Promise.all([
      this.prisma.catalogPart.count({ where }),
      this.prisma.catalogPart.findMany({
        where,
        include: PART_INCLUDE,
        orderBy: this.buildOrderBy(effectiveSort),
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.catalogPart.groupBy({
        by: ['brandId'],
        where,
        _count: { _all: true },
      }),
      this.prisma.catalogPart.aggregate({
        where,
        _min: { priceUzs: true },
        _max: { priceUzs: true },
      }),
    ]);

    // One active-sales query for the whole page; each part is priced against it.
    const sales = items.length ? await this.discounts.loadActiveSales() : [];

    return {
      items: items.map((p) => presentPartItem(p, vehicle, this.discountFor(p, sales))),
      facets: {
        brands: await this.brandFacet(brandFacet),
        price_range_uzs: {
          min: Number(priceAgg._min.priceUzs ?? 0),
          max: Number(priceAgg._max.priceUzs ?? 0),
        },
        compatibility: vehicle
          ? await this.compatibilityFacet(where, vehicle)
          : null,
        // Oil filter chips, present only when the result set can contain oils
        // (null otherwise) — a spare-part listing pays nothing for them.
        motor_oil: await this.motorOilFacet(query, where),
      },
      // Subcategory chips for the macro-category rollup (the "Shop by system"
      // screen renders these as quick filters). Null for a non-rollup listing so
      // an ordinary query pays nothing for the extra grouping.
      subcategories: rollup ? await this.subcategoryChips(where) : null,
      page,
      page_size: pageSize,
      total,
      next_page: page * pageSize < total ? page + 1 : null,
    };
  }

  async detail(partId: string, vehicleId?: string) {
    const part = await this.prisma.catalogPart.findUnique({
      where: { id: partId },
      include: PART_INCLUDE,
    });
    if (!part) throw new NotFoundException('Part not found');
    const vehicle = await this.loadVehicle(vehicleId);
    const sales = await this.discounts.loadActiveSales();
    return presentPartItem(part, vehicle, this.discountFor(part, sales));
  }

  async compatibility(partId: string, vehicleId: string) {
    const part = await this.prisma.catalogPart.findUnique({
      where: { id: partId },
      include: { compatibilities: true },
    });
    if (!part) throw new NotFoundException('Part not found');

    const vehicle = await this.loadVehicle(vehicleId);
    const result = computeCompatibility(part.compatibilities, vehicle);

    // A universal product fits every vehicle by definition, so answer `fits`
    // outright rather than falling through to the "maybe" default. Motor oils
    // are the case that made this matter: they carry no compatibility rows at
    // all, so the generic path would tell a buyer their oil MIGHT not fit.
    if (part.isUniversal) {
      return {
        part_id: partId,
        vehicle_id: vehicleId,
        status: 'fits',
        confidence: 1,
        matched_trims: [],
        matched_engines: [],
        source: 'universal',
      };
    }

    return {
      part_id: partId,
      vehicle_id: vehicleId,
      status: result?.status ?? 'maybe',
      confidence: result?.confidence ?? 0,
      matched_trims: part.compatibilities
        .filter((c) => c.trimId)
        .map((c) => ({ trim_id: c.trimId, years: c.years })),
      matched_engines: [
        ...new Set(
          part.compatibilities
            .filter((c) => c.engineId)
            .map((c) => c.engineId as string),
        ),
      ],
      source: part.compatibilities[0]?.source ?? null,
    };
  }

  /**
   * App-facing compatibility check (`POST :id/check-compatibility`). Same
   * matching engine as `compatibility()` above, but the vehicle can be
   * resolved by `vehicleId` OR `vin`, and the internal `fits|maybe|does_not_fit`
   * status is mapped onto the mobile contract (EXACT_MATCH / UNIVERSAL /
   * NOT_COMPATIBLE / UNCERTAIN) with a ready-to-render badge. The older GET
   * endpoint is kept untouched for backwards compatibility.
   */
  async checkCompatibility(
    partId: string,
    input: { vehicleId?: string; vin?: string },
  ) {
    const part = await this.prisma.catalogPart.findUnique({
      where: { id: partId },
      select: {
        id: true,
        isUniversal: true,
        oemNumbers: true,
        compatibilities: true,
      },
    });
    if (!part) throw new NotFoundException('Part not found');

    const vehicle = input.vehicleId
      ? await this.loadVehicle(input.vehicleId)
      : input.vin
        ? await this.loadVehicleByVin(input.vin)
        : null;

    const oemNumber = part.oemNumbers?.[0] ?? null;
    const echoedVehicleId = input.vehicleId ?? null;

    // A universal product (oil, chemistry, generic fastener/bulb) fits every
    // vehicle by definition — answer UNIVERSAL without touching the match rows.
    if (part.isUniversal) {
      return this.presentCompatibility(part.id, echoedVehicleId, 'universal', oemNumber);
    }

    // No vehicle resolved (neither id nor vin matched a row) → we genuinely
    // can't tell, so UNCERTAIN rather than a false negative.
    const internal = computeCompatibility(part.compatibilities, vehicle)?.status ?? 'maybe';
    return this.presentCompatibility(part.id, echoedVehicleId, internal, oemNumber);
  }

  /** Map an internal fit status onto the app contract (status + badge + details). */
  private presentCompatibility(
    partId: string,
    vehicleId: string | null,
    internal: 'universal' | 'fits' | 'maybe' | 'does_not_fit' | string,
    oemNumber: string | null,
  ) {
    const MAP: Record<
      string,
      {
        status: string;
        isCompatible: boolean;
        color: 'green' | 'yellow' | 'red';
        text: string;
        matchedBy: 'MODEL_REF' | 'OEM_NUMBER' | 'UNIVERSAL';
      }
    > = {
      universal: {
        status: 'UNIVERSAL',
        isCompatible: true,
        color: 'green',
        text: 'Универсальный товар',
        matchedBy: 'UNIVERSAL',
      },
      fits: {
        status: 'EXACT_MATCH',
        isCompatible: true,
        color: 'green',
        text: '100% Подходит для вашего авто',
        matchedBy: 'MODEL_REF',
      },
      maybe: {
        status: 'UNCERTAIN',
        isCompatible: true,
        color: 'yellow',
        text: 'Требует уточнения (проверьте VIN)',
        matchedBy: 'MODEL_REF',
      },
      does_not_fit: {
        status: 'NOT_COMPATIBLE',
        isCompatible: false,
        color: 'red',
        text: 'Не подходит для вашего авто',
        matchedBy: 'MODEL_REF',
      },
    };
    const m = MAP[internal] ?? MAP.maybe;
    return {
      partId,
      vehicleId,
      status: m.status,
      isCompatible: m.isCompatible,
      badge: { text: m.text, color: m.color },
      details: { matchedBy: m.matchedBy, oemNumber },
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  private buildWhere(
    q: ListPartsQueryDto,
    vehicle: VehicleFilterContext | null,
  ): Prisma.CatalogPartWhereInput {
    const and: Prisma.CatalogPartWhereInput[] = [];

    // Category filter — three-way, unified around PartCategory being the source
    // of truth while staying fully back-compatible:
    //   1. Value is a PartMainCategory enum (e.g. build 31 sends "BRAKES") →
    //      filter mainCategory. Parts keep their bot-assigned main_category, so
    //      this path is untouched.
    //   2. Value is a PartVehicleCategory enum (BRAKE_SYSTEM, …) → filter
    //      vehicleCategory.
    //   3. Anything else → treat as a PartCategory id/slug on the categoryId FK.
    // The canonical category ids ARE the main-category slugs, so the new app can
    // send either form and both resolve to the same parts: 'brakes' upshifts to
    // enum BRAKES (path 1), while a non-enum slug like 'oil-and-fluids' falls to
    // categoryId (path 3, correct because the migration backfilled category_id
    // from main_category). A custom admin-created category id also lands on
    // path 3. No value 404s.
    if (q.category) {
      const up = q.category.toUpperCase();
      if (MAIN_CATEGORY_VALUES.has(up as PartMainCategory)) {
        and.push({ mainCategory: up as PartMainCategory });
      } else if (VEHICLE_CATEGORY_VALUES.has(up as PartVehicleCategory)) {
        and.push({ vehicleCategory: up as PartVehicleCategory });
      } else {
        and.push({ categoryId: q.category });
      }
    }
    // Macro-category ROLLUP: filter every part in the system regardless of which
    // subcategory it is filed under. Unknown values are ignored (never 400) —
    // the same lenient rule the other filters follow.
    const rollup = this.rollupMainCategory(q);
    if (rollup) and.push({ mainCategory: rollup });
    if (q.vehicle_category) {
      const up = q.vehicle_category.toUpperCase();
      if (VEHICLE_CATEGORY_VALUES.has(up as PartVehicleCategory)) {
        and.push({ vehicleCategory: up as PartVehicleCategory });
      }
    }

    // Make / model filters — independent of the garage filter. Match on the
    // denormalized fit rows by slug OR canonical name (case-insensitive), so both
    // "make_chevrolet" and "Chevrolet" work. Universal parts (no fit rows) are
    // included since they fit every make/model.
    if (q.make) and.push(this.makeWhere(q.make));
    if (q.model) and.push(this.modelWhere(q.model));

    // Garage vehicle: only compatible parts. A part fits when it is universal, OR
    // its make/model fit rows match the vehicle, OR its trim/engine compatibility
    // rows are not an explicit miss. We approximate at the make/model level here
    // (indexed); the per-item compatibility annotation still uses trim/engine.
    if (vehicle) and.push(this.vehicleWhere(vehicle));

    if (q.brand) {
      and.push({
        brandId: {
          in: q.brand
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        },
      });
    }
    if (q.region && q.region.length > 0) {
      const regions = q.region.map((r) => REGION_BY_WIRE[r]).filter(Boolean);
      if (regions.length > 0) and.push({ originRegion: { in: regions } });
    }
    if (q.gm_only === 'true') and.push({ isGm: true });
    if (q.oem_only === 'true') and.push({ isOem: true });
    if (q.in_stock_only === 'true') and.push({ inStock: true });
    if (q.q) and.push({ title: { contains: q.q, mode: 'insensitive' } });

    // Listing kind + the kind-specific attribute filters (motor oils).
    for (const cond of this.kindWhere(q)) and.push(cond);

    return and.length > 0 ? { AND: and } : {};
  }

  /**
   * The `kind` filter plus the motor-oil attribute filters.
   *
   * Two rules worth stating explicitly, because they decide what a buyer sees:
   *
   * 1. NO `kind` param means NO kind predicate — every kind is returned, exactly
   *    as before `ProductKind` existed. Spare-part queries therefore keep their
   *    historical result set; nothing silently narrows.
   *
   * 2. An oil-attribute filter (viscosity / oil_type / volume) IMPLIES
   *    `kind = MOTOR_OIL`. Those attributes are null on every other kind, so the
   *    rows returned would be oils regardless — but stating it makes the intent
   *    explicit rather than incidental, and keeps the facet counts computed over
   *    the set the buyer actually asked for.
   *
   * All attribute lists are OR-within / AND-across: `viscosity=5W-30&
   * viscosity=0W-20&oil_type=synthetic` means "(5W-30 or 0W-20) and synthetic".
   */
  private kindWhere(q: ListPartsQueryDto): Prisma.CatalogPartWhereInput[] {
    const conds: Prisma.CatalogPartWhereInput[] = [];

    const viscosities = q.viscosity ?? [];
    const oilTypes = (q.oil_type ?? [])
      .map((t) => OIL_TYPE_BY_WIRE[t])
      .filter(Boolean);
    const volumes = q.volume_ml ?? [];
    const hasVolumeRange =
      q.volume_ml_min !== undefined || q.volume_ml_max !== undefined;
    const usesOilFilter =
      viscosities.length > 0 ||
      oilTypes.length > 0 ||
      volumes.length > 0 ||
      hasVolumeRange;

    const kinds = (q.kind ?? []).map((k) => KIND_BY_WIRE[k]).filter(Boolean);
    if (kinds.length > 0) {
      conds.push({ kind: { in: kinds } });
    } else if (usesOilFilter) {
      conds.push({ kind: ProductKind.MOTOR_OIL });
    }

    if (viscosities.length > 0) {
      // Exact, case-insensitive match per value — never `contains`, which would
      // make "5W-30" also match "15W-30" and quietly widen the filter.
      conds.push({
        OR: viscosities.map((v) => ({
          oilViscosity: { equals: v, mode: 'insensitive' as const },
        })),
      });
    }
    if (oilTypes.length > 0) conds.push({ oilType: { in: oilTypes } });
    if (volumes.length > 0) conds.push({ oilVolumeMl: { in: volumes } });
    if (hasVolumeRange) {
      conds.push({
        oilVolumeMl: {
          ...(q.volume_ml_min !== undefined ? { gte: q.volume_ml_min } : {}),
          ...(q.volume_ml_max !== undefined ? { lte: q.volume_ml_max } : {}),
        },
      });
    }

    return conds;
  }

  /** Match universal parts OR parts whose fit rows reference the make. */
  private makeWhere(make: string): Prisma.CatalogPartWhereInput {
    const value = make.trim();
    return {
      OR: [
        { isUniversal: true },
        {
          fits: {
            some: {
              OR: [
                { makeSlug: value },
                { makeName: { equals: value, mode: 'insensitive' } },
              ],
            },
          },
        },
      ],
    };
  }

  /** Match universal parts OR parts whose fit rows reference the model. */
  private modelWhere(model: string): Prisma.CatalogPartWhereInput {
    const value = model.trim();
    return {
      OR: [
        { isUniversal: true },
        {
          fits: {
            some: {
              OR: [
                { modelSlug: value },
                { modelName: { equals: value, mode: 'insensitive' } },
              ],
            },
          },
        },
      ],
    };
  }

  /**
   * Garage-vehicle compatibility filter. A part is returned when:
   *   • it is universal, OR
   *   • its make/model fit rows match the vehicle's make/model, OR
   *   • it has a trim/engine compatibility row for the vehicle that is not an
   *     explicit DOES_NOT_FIT.
   * Parts with no fitment data at all are excluded (they can't be confirmed to
   * fit the selected vehicle).
   */
  private vehicleWhere(
    vehicle: VehicleFilterContext,
  ): Prisma.CatalogPartWhereInput {
    const or: Prisma.CatalogPartWhereInput[] = [{ isUniversal: true }];

    if (vehicle.makeName || vehicle.modelName) {
      const fitConds: Prisma.CatalogPartFitWhereInput[] = [];
      if (vehicle.modelName)
        fitConds.push({
          modelName: { equals: vehicle.modelName, mode: 'insensitive' },
        });
      if (vehicle.makeName)
        fitConds.push({
          makeName: { equals: vehicle.makeName, mode: 'insensitive' },
        });
      or.push({ fits: { some: { AND: [{ OR: fitConds }] } } });
    }

    if (vehicle.trimId || vehicle.engineId) {
      const compatOr: Prisma.PartCompatibilityWhereInput[] = [];
      if (vehicle.trimId) compatOr.push({ trimId: vehicle.trimId });
      if (vehicle.engineId) compatOr.push({ engineId: vehicle.engineId });
      or.push({
        compatibilities: {
          some: {
            AND: [{ OR: compatOr }, { NOT: { status: 'DOES_NOT_FIT' } }],
          },
        },
      });
    }

    return { OR: or };
  }

  private buildOrderBy(
    sort?: string,
  ): Prisma.CatalogPartOrderByWithRelationInput[] {
    if (sort === 'price_asc') return [{ priceUzs: 'asc' }];
    if (sort === 'price_desc') return [{ priceUzs: 'desc' }];
    // Bestsellers first, then most-sold, then best-reviewed/rated, newest last.
    // The composite means the sort stays sensible before is_bestseller/sales_count
    // are populated (they fall through to the rating/review tiebreakers).
    if (sort === 'bestseller') {
      return [
        { isBestseller: 'desc' },
        { salesCount: 'desc' },
        { reviewCount: 'desc' },
        { ratingAvg: { sort: 'desc', nulls: 'last' } },
        { createdAt: 'desc' },
      ];
    }
    return [{ createdAt: 'desc' }];
  }

  /**
   * The macro-category this request rolls up, or null. Resolved from the explicit
   * `mainCategory` param, or from a `category` value that is itself a
   * PartMainCategory enum. Case-insensitive; an unknown value resolves to null.
   */
  private rollupMainCategory(q: ListPartsQueryDto): PartMainCategory | null {
    for (const raw of [q.mainCategory, q.category]) {
      if (!raw) continue;
      const up = raw.toUpperCase();
      if (MAIN_CATEGORY_VALUES.has(up as PartMainCategory)) {
        return up as PartMainCategory;
      }
    }
    return null;
  }

  /**
   * Subcategory chips for a macro-category rollup: the real subcategories that
   * actually have parts in the current result set, with counts — so the client
   * renders quick filters that never lead to an empty page. The 12 mainCategory
   * BUCKETS are excluded (they are the home-grid taxonomy, not drill chips).
   */
  private async subcategoryChips(where: Prisma.CatalogPartWhereInput) {
    const grouped = await this.prisma.catalogPart.groupBy({
      by: ['categoryId'],
      where,
      _count: { _all: true },
    });
    const ids = grouped.map((g) => g.categoryId);
    if (ids.length === 0) return [];

    const cats = await this.prisma.partCategory.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        name: true,
        nameRu: true,
        nameUz: true,
        nameEn: true,
        sortOrder: true,
      },
    });
    const bucketIds = new Set<string>(Object.values(MAIN_CATEGORY_TO_SLUG));
    const countById = new Map(grouped.map((g) => [g.categoryId, g._count._all]));

    return cats
      .filter((c) => !bucketIds.has(c.id))
      .map((c) => ({
        id: c.id,
        name: c.name,
        // Wire keys unchanged (the buyer app already reads title_ru/title_uz);
        // only their SOURCE moved to the renamed, now-required columns.
        // `title_en` joins them for the app's English locale.
        title_ru: c.nameRu,
        title_uz: c.nameUz,
        title_en: c.nameEn,
        count: countById.get(c.id) ?? 0,
      }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  private async loadVehicle(
    vehicleId?: string,
  ): Promise<VehicleFilterContext | null> {
    if (!vehicleId) return null;
    const v = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: VEHICLE_CONTEXT_SELECT,
    });
    return v ? mapVehicleContext(v) : null;
  }

  /** Resolve a vehicle context by raw VIN (fallback path for the app when it
   *  only holds a VIN). VIN is not unique in the schema, so take the first
   *  match — any vehicle with this VIN yields the same trim/engine context. */
  private async loadVehicleByVin(
    vin: string,
  ): Promise<VehicleFilterContext | null> {
    if (!vin) return null;
    const v = await this.prisma.vehicle.findFirst({
      where: { vin },
      select: VEHICLE_CONTEXT_SELECT,
    });
    return v ? mapVehicleContext(v) : null;
  }

  private async brandFacet(
    grouped: { brandId: string | null; _count: { _all: number } }[],
  ) {
    const ids = grouped.map((g) => g.brandId).filter((x): x is string => !!x);
    const brands = await this.prisma.partBrand.findMany({
      where: { id: { in: ids } },
    });
    const names = new Map(brands.map((b) => [b.id, b.name]));
    return grouped
      .filter((g) => g.brandId)
      .map((g) => ({
        id: g.brandId,
        name: names.get(g.brandId as string) ?? g.brandId,
        count: g._count._all,
      }));
  }

  /**
   * Available viscosity / oil-type / volume values within the CURRENT result set,
   * with counts — the data a client needs to render oil filter chips that never
   * lead to an empty page.
   *
   * Returns null (and runs no query) unless the request can actually contain
   * oils, i.e. the caller asked for `kind=motor_oil` or used an oil attribute
   * filter. A plain spare-part or unfiltered listing therefore costs exactly what
   * it cost before oils existed — this is the reason the facet is conditional
   * rather than always computed.
   *
   * Volumes are returned raw (millilitres, the stored unit) alongside a display
   * label, so a client can filter by `volume_ml` and label the chip "4 л" without
   * duplicating the formatting rule.
   */
  private async motorOilFacet(
    q: ListPartsQueryDto,
    where: Prisma.CatalogPartWhereInput,
  ) {
    const asksForOils =
      (q.kind ?? []).includes('motor_oil') ||
      (q.viscosity?.length ?? 0) > 0 ||
      (q.oil_type?.length ?? 0) > 0 ||
      (q.volume_ml?.length ?? 0) > 0 ||
      q.volume_ml_min !== undefined ||
      q.volume_ml_max !== undefined;
    if (!asksForOils) return null;

    const [byViscosity, byType, byVolume] = await Promise.all([
      this.prisma.catalogPart.groupBy({
        by: ['oilViscosity'],
        where,
        _count: { _all: true },
      }),
      this.prisma.catalogPart.groupBy({
        by: ['oilType'],
        where,
        _count: { _all: true },
      }),
      this.prisma.catalogPart.groupBy({
        by: ['oilVolumeMl'],
        where,
        _count: { _all: true },
      }),
    ]);

    return {
      // A null attribute is not a facet value — it means "this row is not an
      // oil" (or the attribute is unset), so it is dropped rather than surfaced
      // as an empty chip.
      viscosity: byViscosity
        .filter((g) => g.oilViscosity !== null)
        .map((g) => ({
          value: g.oilViscosity as string,
          count: g._count._all,
        }))
        .sort((a, b) => a.value.localeCompare(b.value)),
      oil_type: byType
        .filter((g) => g.oilType !== null)
        .map((g) => ({
          value: g.oilType as OilType,
          label: OIL_TYPE_LABELS[g.oilType as OilType],
          count: g._count._all,
        })),
      volume: byVolume
        .filter((g) => g.oilVolumeMl !== null)
        .map((g) => ({
          volume_ml: g.oilVolumeMl as number,
          label: formatVolume(g.oilVolumeMl as number),
          count: g._count._all,
        }))
        .sort((a, b) => a.volume_ml - b.volume_ml),
    };
  }

  private async compatibilityFacet(
    where: Prisma.CatalogPartWhereInput,
    vehicle: VehicleCompatContext,
  ) {
    const all = await this.prisma.catalogPart.findMany({
      where,
      select: { compatibilities: true },
    });
    let fits = 0;
    let maybe = 0;
    let doesNotFit = 0;
    for (const p of all) {
      const c = computeCompatibility(p.compatibilities, vehicle);
      if (c?.status === 'fits') fits++;
      else if (c?.status === 'does_not_fit') doesNotFit++;
      else maybe++;
    }
    return { fits, maybe, does_not_fit: doesNotFit };
  }
}
