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
import { normalizeOem } from '../../common/normalize-oem.util';
import { MAIN_CATEGORY_TO_SLUG } from '../categories/category-map';
import {
  AppLang,
  DEFAULT_APP_LANG,
  localizedCategoryName,
} from '../../common/app-lang.util';
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
  curatedModelIds,
  VehicleCompatContext,
} from './part.presenter';
import { ActiveSale, DiscountResult, DiscountService } from '../../sales/discount.service';
import {
  HAS_NO_CURATED_FITMENT,
  VEHICLE_FIT_SELECT,
  VehicleFitContext,
  toVehicleFitContext,
  vehicleFitWhere,
} from '../compatibility/vehicle-fitment';

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
// Reverse of MAIN_CATEGORY_TO_SLUG: the home grid ships each bucket by its slug
// id ('belts-and-hoses'), whose UPPERCASE ('BELTS-AND-HOSES') does NOT match the
// underscored enum ('BELTS_AND_HOSES'). This map lets the listing recognise a
// main-category SLUG and roll up the whole system (all subcategories), so the
// listing count matches the home grid's mainCategory-grouped count.
const SLUG_TO_MAIN_CATEGORY = new Map<string, PartMainCategory>(
  (Object.entries(MAIN_CATEGORY_TO_SLUG) as [PartMainCategory, string][]).map(
    ([main, slug]) => [slug, main],
  ),
);

/** Only the curated model ids — what a compatibility decision reads. */
const CURATED_IDS_SELECT = {
  select: { vehicleModelId: true },
} satisfies Prisma.FitmentBindingFindManyArgs;

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

  /**
   * Faceted parts listing. `lang` reaches presentation only — the where-clause,
   * the facets' grouping keys and the sort are all language-independent, so the
   * same query returns the same rows in the same order in every language.
   */
  async list(query: ListPartsQueryDto, lang: AppLang = DEFAULT_APP_LANG) {
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
      items: items.map((p) =>
        presentPartItem(p, vehicle, this.discountFor(p, sales), lang),
      ),
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
      subcategories: rollup ? await this.subcategoryChips(where, lang) : null,
      page,
      page_size: pageSize,
      total,
      next_page: page * pageSize < total ? page + 1 : null,
    };
  }

  async detail(
    partId: string,
    vehicleId?: string,
    lang: AppLang = DEFAULT_APP_LANG,
  ) {
    const part = await this.prisma.catalogPart.findUnique({
      where: { id: partId },
      include: PART_INCLUDE,
    });
    if (!part) throw new NotFoundException('Part not found');
    const vehicle = await this.loadVehicle(vehicleId);
    const sales = await this.discounts.loadActiveSales();
    return presentPartItem(part, vehicle, this.discountFor(part, sales), lang);
  }

  async compatibility(partId: string, vehicleId: string) {
    const part = await this.prisma.catalogPart.findUnique({
      where: { id: partId },
      include: { compatibilities: true, fitmentBindings: CURATED_IDS_SELECT },
    });
    if (!part) throw new NotFoundException('Part not found');

    const vehicle = await this.loadVehicle(vehicleId);
    const curated = curatedModelIds(part);
    const result = computeCompatibility(part.compatibilities, vehicle, curated);
    const curatedFit =
      !!vehicle?.modelId &&
      curated.includes(vehicle.modelId) &&
      result?.status === 'fits';

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
      // 'fitment' when the answer came from a curated Fitment Studio binding.
      source: curatedFit
        ? 'fitment'
        : (part.compatibilities[0]?.source ?? null),
    };
  }

  /**
   * App-facing compatibility check (`POST :id/check-compatibility`). Same
   * matching engine as `compatibility()` above, but the vehicle can be
   * resolved by `vehicleId` OR `vin`, and the internal `fits|maybe|does_not_fit`
   * status is mapped onto the mobile contract (EXACT_MATCH / UNIVERSAL /
   * NOT_COMPATIBLE / UNCERTAIN) with a ready-to-render badge. The older GET
   * endpoint is kept untouched for backwards compatibility.
   *
   * The vehicle is resolved ONLY among the caller's own garage (`userId`, from
   * the optional bearer token): a VIN is not a secret, so an unscoped lookup
   * let anyone probe whether some other user registered a car. An anonymous
   * caller has no garage, so it gets UNCERTAIN (never a false red) for a
   * non-universal part — exactly as for an unknown vehicle.
   */
  async checkCompatibility(
    partId: string,
    input: { vehicleId?: string; vin?: string },
    userId?: string | null,
  ) {
    const part = await this.prisma.catalogPart.findUnique({
      where: { id: partId },
      select: {
        id: true,
        isUniversal: true,
        oemNumbers: true,
        compatibilities: true,
        fitmentBindings: CURATED_IDS_SELECT,
      },
    });
    if (!part) throw new NotFoundException('Part not found');

    const vehicle = !userId
      ? null
      : input.vehicleId
        ? await this.loadOwnedVehicle(userId, input.vehicleId)
        : input.vin
          ? await this.loadOwnedVehicleByVin(userId, input.vin)
          : null;

    const oemNumber = part.oemNumbers?.[0] ?? null;
    const echoedVehicleId = input.vehicleId ?? null;

    // A universal product (oil, chemistry, generic fastener/bulb) fits every
    // vehicle by definition — answer UNIVERSAL without touching the match rows.
    if (part.isUniversal) {
      return this.presentCompatibility(
        part.id,
        echoedVehicleId,
        'universal',
        oemNumber,
      );
    }

    // No vehicle resolved (neither id nor vin matched a row) → we genuinely
    // can't tell, so UNCERTAIN rather than a false negative. A curated binding
    // to the vehicle's exact model is enough for EXACT_MATCH on its own.
    const internal =
      computeCompatibility(part.compatibilities, vehicle, curatedModelIds(part))
        ?.status ?? 'maybe';
    return this.presentCompatibility(
      part.id,
      echoedVehicleId,
      internal,
      oemNumber,
    );
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
    vehicle: VehicleFitContext | null,
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
        // Main-category enum ('BRAKES') → handled by the rollup clause below so
        // the whole system (incl. subcategory-filed parts) is returned.
      } else if (VEHICLE_CATEGORY_VALUES.has(up as PartVehicleCategory)) {
        and.push({ vehicleCategory: up as PartVehicleCategory });
      } else if (SLUG_TO_MAIN_CATEGORY.has(q.category.toLowerCase())) {
        // Main-category SLUG ('belts-and-hoses') → also a rollup; the exact
        // categoryId path below would match only the bucket row itself and drop
        // every part filed on a subcategory (the "count 2, list empty" bug).
      } else {
        // A real subcategory / custom category id → exact FK match.
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

    // Make / model filters — independent of the garage filter. Curated bindings
    // match through their VehicleModelRef (id or name); uncurated parts match
    // their denormalized fit rows by slug OR canonical name (case-insensitive),
    // so both "make_chevrolet" and "Chevrolet" work. Universal parts (no fit
    // rows) are included since they fit every make/model.
    if (q.make) and.push(this.makeWhere(q.make));
    if (q.model) and.push(this.modelWhere(q.model, q.make));

    // Garage vehicle: only compatible parts — the shared decision path (curated
    // model id, legacy make+model names, make-wide, trim/engine, universal).
    if (vehicle) and.push(vehicleFitWhere(vehicle));

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
    // Free-text search: fuzzy title match OR exact article match. Article search
    // normalizes the query (strip separators, uppercase) and looks it up inside
    // the `oemNumbers` / `gmNumbers` arrays with `has` (exact membership → uses
    // the GIN indexes). The `has` clauses are added only when the normalized
    // query is non-empty, so a punctuation-only `q` stays a pure title search.
    if (q.q) {
      const normalized = normalizeOem(q.q);
      const or: Prisma.CatalogPartWhereInput[] = [
        { title: { contains: q.q, mode: 'insensitive' } },
      ];
      if (normalized.length > 0) {
        or.push({ oemNumbers: { has: normalized } });
        or.push({ gmNumbers: { has: normalized } });
      }
      and.push({ OR: or });
    }

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

  /**
   * Match universal parts, parts CURATED to a model of the make (reference make
   * by id, name or `make_<id>` slug), OR — for uncurated parts only — parts
   * whose fit rows reference the make. A curated part is decided by its
   * bindings alone (see catalog/compatibility/vehicle-fitment.ts).
   */
  private makeWhere(make: string): Prisma.CatalogPartWhereInput {
    const value = make.trim();
    const makeRef: Prisma.VehicleMakeWhereInput[] = [
      { id: value },
      { name: { equals: value, mode: 'insensitive' } },
    ];
    const slugMake = /^make_(.+)$/.exec(value)?.[1];
    if (slugMake) makeRef.push({ id: slugMake });
    return {
      OR: [
        { isUniversal: true },
        {
          fitmentBindings: {
            some: { vehicleModel: { make: { OR: makeRef } } },
          },
        },
        {
          AND: [
            HAS_NO_CURATED_FITMENT,
            {
              OR: [
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
                // Make-wide parts ("every model of this make") match their make.
                { makeFits: { some: this.makeFitMatch(value) } },
              ],
            },
          ],
        },
      ],
    };
  }

  /**
   * Match universal parts, parts CURATED to the model (reference model by id,
   * name, or a `model_<makeId>_<modelId>` slug), OR — for uncurated parts only —
   * parts whose fit rows reference the model, or make-wide parts of that
   * model's make. The make is known from a model SLUG (model_<make>_<model>)
   * or from an explicit `make` filter; a bare model name with no make gives no
   * make to match, so make-wide parts are not claimed for it.
   */
  private modelWhere(
    model: string,
    make?: string,
  ): Prisma.CatalogPartWhereInput {
    const value = model.trim();
    const slug = /^model_([a-z0-9-]+)_(.+)$/.exec(value);
    const modelRef: Prisma.VehicleModelRefWhereInput[] = [
      { id: value },
      { name: { equals: value, mode: 'insensitive' } },
    ];
    if (slug) modelRef.push({ makeId: slug[1], id: slug[2] });

    const legacy: Prisma.CatalogPartWhereInput[] = [
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
    ];
    if (slug) {
      legacy.push({ makeFits: { some: { makeSlug: `make_${slug[1]}` } } });
    }
    if (make?.trim()) {
      legacy.push({ makeFits: { some: this.makeFitMatch(make.trim()) } });
    }
    return {
      OR: [
        { isUniversal: true },
        { fitmentBindings: { some: { vehicleModel: { OR: modelRef } } } },
        { AND: [HAS_NO_CURATED_FITMENT, { OR: legacy }] },
      ],
    };
  }

  /** A make-wide fit row matching a make given as slug or canonical name. */
  private makeFitMatch(value: string): Prisma.CatalogPartMakeFitWhereInput {
    return {
      OR: [
        { makeSlug: value },
        { makeName: { equals: value, mode: 'insensitive' } },
      ],
    };
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
      // Also accept the canonical SLUG form ('belts-and-hoses'), which the home
      // grid ships as the category id but which doesn't uppercase to the enum.
      const bySlug = SLUG_TO_MAIN_CATEGORY.get(raw.toLowerCase());
      if (bySlug) return bySlug;
    }
    return null;
  }

  /**
   * Subcategory chips for a macro-category rollup: the real subcategories that
   * actually have parts in the current result set, with counts — so the client
   * renders quick filters that never lead to an empty page. The 12 mainCategory
   * BUCKETS are excluded (they are the home-grid taxonomy, not drill chips).
   */
  private async subcategoryChips(
    where: Prisma.CatalogPartWhereInput,
    lang: AppLang,
  ) {
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
    const countById = new Map(
      grouped.map((g) => [g.categoryId, g._count._all]),
    );

    return cats
      .filter((c) => !bucketIds.has(c.id))
      .map((c) => ({
        id: c.id,
        name: c.name,
        // The chip's display text in the REQUEST's language. `title_*` below
        // stay for a client that re-renders a cached chip on a language switch.
        label: localizedCategoryName(c, lang),
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
  ): Promise<VehicleFitContext | null> {
    if (!vehicleId) return null;
    const v = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: VEHICLE_FIT_SELECT,
    });
    return v ? toVehicleFitContext(v) : null;
  }

  /** A vehicle of the caller's OWN (not soft-deleted) garage, or null. */
  private async loadOwnedVehicle(
    userId: string,
    vehicleId: string,
  ): Promise<VehicleFitContext | null> {
    const v = await this.prisma.vehicle.findFirst({
      where: { id: vehicleId, userId, deletedAt: null },
      select: VEHICLE_FIT_SELECT,
    });
    return v ? toVehicleFitContext(v) : null;
  }

  /** Resolve a vehicle context by raw VIN (fallback path for the app when it
   *  only holds a VIN) — searched ONLY in the caller's own garage. VIN is not
   *  unique in the schema, so take the first of the caller's matches. */
  private async loadOwnedVehicleByVin(
    userId: string,
    vin: string,
  ): Promise<VehicleFitContext | null> {
    if (!vin) return null;
    const v = await this.prisma.vehicle.findFirst({
      where: { vin, userId, deletedAt: null },
      select: VEHICLE_FIT_SELECT,
    });
    return v ? toVehicleFitContext(v) : null;
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
      select: { compatibilities: true, fitmentBindings: CURATED_IDS_SELECT },
    });
    let fits = 0;
    let maybe = 0;
    let doesNotFit = 0;
    for (const p of all) {
      const c = computeCompatibility(
        p.compatibilities,
        vehicle,
        curatedModelIds(p),
      );
      if (c?.status === 'fits') fits++;
      else if (c?.status === 'does_not_fit') doesNotFit++;
      else maybe++;
    }
    return { fits, maybe, does_not_fit: doesNotFit };
  }
}
