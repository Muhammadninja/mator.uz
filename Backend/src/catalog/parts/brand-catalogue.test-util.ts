/**
 * TEST-ONLY: a buyer catalogue of 132 parts over five part brands, and a
 * Prisma double that answers PartsService.list from it — the count, the page
 * (`findMany`: where, orderBy, skip/take), the facet groupBys, the price
 * aggregate and the brand names — by running the listing's real predicates
 * over the rows (where-eval), so a test asserts which parts come back.
 *
 * 52 buyer-listed parts are Bosch, and the unfiltered listing (newest first:
 * catalogue order) serves only two of them on its first page of 24; the other
 * 50 are spread over the pages after it. Sachs is not on that first page at
 * all. Every part is filed in the brake system (front pads, discs) or under
 * shock absorbers, and fits a Chevrolet Cobalt, a BYD Song Plus or a
 * Volkswagen Polo. The last two parts are a brandless one and a Bosch one no
 * buyer may see (no photo).
 */
import {
  PartMainCategory,
  PartOriginRegion,
  type PartBrand,
} from '@prisma/client';
import { BUYER_LISTED_PART } from '../buyer-visibility';
import { matchesWhere } from '../compatibility/where-eval.test-util';
import * as fx from '../compatibility/fitment-fixtures.test-util';

export const BOSCH = 'brand_bosch';
export const MANN = 'brand_mann';
export const GATES = 'brand_gates';
export const FEBI = 'brand_febi';
export const SACHS = 'brand_sachs';

/** The part_brands rows (the directory the facet takes names from). */
export const PART_BRANDS: PartBrand[] = [
  { id: BOSCH, name: 'Bosch', logoUrl: null },
  { id: MANN, name: 'MANN-FILTER', logoUrl: null },
  { id: GATES, name: 'Gates', logoUrl: null },
  { id: FEBI, name: 'Febi', logoUrl: null },
  { id: SACHS, name: 'Sachs', logoUrl: null },
];

/** `parent_id` edges of the part_categories rows the parts are filed on. */
const PARENT: Record<string, string | null> = {
  'brake-system': null,
  'front-brake-pads': 'brake-system',
  'brake-discs': 'brake-system',
  'suspension-and-steering': null,
  'shock-absorbers': 'suspension-and-steering',
};

/** A category as Prisma includes it, `parent` chain and all. */
function node(id: string): Record<string, unknown> {
  const parentId = PARENT[id];
  return {
    id,
    name: id,
    nameRu: id,
    nameUz: id,
    nameEn: id,
    parentId,
    parent: parentId ? node(parentId) : null,
  };
}

const CARS: [string, string][] = [
  ['Chevrolet', 'Cobalt'],
  ['BYD', 'Song Plus'],
  ['Volkswagen', 'Polo'],
];

/** The brand of the i-th part (0-based). */
function brandAt(i: number): string | null {
  if (i === 130) return null;
  if (i === 131) return BOSCH;
  const bosch = i < 24 ? i === 4 || i === 16 : i % 2 === 0 && i < 124;
  if (bosch) return BOSCH;
  return i < 24
    ? [MANN, GATES, FEBI][i % 3]
    : [MANN, GATES, FEBI, SACHS][i % 4];
}

/** The i-th part, as PartsService reads a row (PART_INCLUDE relations). */
function partAt(i: number) {
  // Neighbours share their filing, car and flags, so every brand gets a mix.
  const k = Math.floor(i / 2);
  const shocks = k % 4 === 3;
  const categoryId = shocks
    ? 'shock-absorbers'
    : k % 2
      ? 'brake-discs'
      : 'front-brake-pads';
  const brandId = brandAt(i);
  const brand = PART_BRANDS.find((b) => b.id === brandId) ?? null;
  return {
    ...fx.part({
      id: `p${String(i + 1).padStart(3, '0')}`,
      fits: [CARS[k % 3]],
    }),
    ...(i === 131 ? { images: [] } : {}),
    title: `${shocks ? 'Shock absorber' : k % 2 ? 'Brake disc' : 'Brake pad'} ${i + 1}`,
    brandId,
    brand,
    categoryId,
    category: node(categoryId),
    mainCategory: shocks
      ? PartMainCategory.SUSPENSION
      : PartMainCategory.BRAKES,
    vehicleCategory: null,
    sellerId: 'seller_avtomir',
    seller: {
      id: 'seller_avtomir',
      name: 'Avtomir',
      ratingAvg: 4.5,
      certified: false,
      lowestPrice: false,
      status: 'ACTIVE',
    },
    oemNumbers: [],
    gmNumbers: [],
    partNumberType: 'UNKNOWN',
    priceUzs: 100_000 + ((i * 7919) % 50) * 1_000,
    currency: 'UZS',
    inStock: true,
    deliveryEtaDaysMin: null,
    deliveryEtaDaysMax: null,
    partBrandName: null,
    originRegion: k % 2 ? PartOriginRegion.EUROPE : PartOriginRegion.CHINA,
    isGm: k % 5 === 0,
    isOem: k % 6 === 0,
    kind: 'SPARE_PART',
    oilViscosity: null,
    oilType: null,
    oilVolumeMl: null,
    antifreezeWeightG: null,
    ratingAvg: null,
    reviewCount: 0,
    isBestseller: false,
    salesCount: 0,
    // One minute apart, the first part newest: the default listing order is
    // the catalogue order.
    createdAt: new Date(Date.UTC(2026, 9, 1) - i * 60_000),
  };
}

export type CatalogueRow = ReturnType<typeof partAt>;

export const CATALOGUE: CatalogueRow[] = Array.from({ length: 132 }, (_, i) =>
  partAt(i),
);

/** Ids of the parts a buyer may see that carry `brandId`, in catalogue order. */
export function listedOf(brandId: string | null): string[] {
  return CATALOGUE.filter(
    (p) => p.brandId === brandId && matchesWhere(p, BUYER_LISTED_PART),
  ).map((p) => p.id);
}

/** What a sort key compares: dates by time, flags as 0/1. */
function sortable(v: unknown): number | string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v as number | string;
}

/** `rows` in `orderBy` order, nulls last, as PostgreSQL sorts them. */
function ordered(
  rows: CatalogueRow[],
  orderBy: Record<string, unknown>[] = [],
): CatalogueRow[] {
  return [...rows].sort((a, b) => {
    for (const key of orderBy) {
      const [field, spec] = Object.entries(key)[0];
      const dir =
        typeof spec === 'string' ? spec : (spec as { sort: string }).sort;
      const x = sortable((a as Record<string, unknown>)[field]);
      const y = sortable((b as Record<string, unknown>)[field]);
      if (x === y) continue;
      if (x === null) return 1;
      if (y === null) return -1;
      return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
}

/** The page query PartsService sends (`findMany`). */
export interface PageQuery {
  where: unknown;
  orderBy: Record<string, unknown>[];
  skip: number;
  take: number;
}

/** The Prisma calls PartsService.list makes, answered from `rows`. Every
 *  count and page query is kept, in order. */
export function catalogPrisma(rows: CatalogueRow[] = CATALOGUE) {
  const counted: unknown[] = [];
  const paged: PageQuery[] = [];
  const select = (where: unknown) => rows.filter((r) => matchesWhere(r, where));
  return {
    counted,
    paged,
    catalogPart: {
      count: ({ where }: { where: unknown }) => {
        counted.push(where);
        return Promise.resolve(select(where).length);
      },
      findMany: (q: PageQuery) => {
        paged.push(q);
        return Promise.resolve(
          ordered(select(q.where), q.orderBy).slice(q.skip, q.skip + q.take),
        );
      },
      groupBy: ({ by, where }: { by: string[]; where: unknown }) => {
        const counts = new Map<unknown, number>();
        for (const r of select(where)) {
          const value = (r as Record<string, unknown>)[by[0]];
          counts.set(value, (counts.get(value) ?? 0) + 1);
        }
        return Promise.resolve(
          [...counts].map(([value, n]) => ({
            [by[0]]: value,
            _count: { _all: n },
          })),
        );
      },
      aggregate: ({ where }: { where: unknown }) => {
        const prices = select(where).map((r) => r.priceUzs);
        return Promise.resolve({
          _min: { priceUzs: prices.length ? Math.min(...prices) : null },
          _max: { priceUzs: prices.length ? Math.max(...prices) : null },
        });
      },
    },
    partBrand: {
      findMany: ({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(PART_BRANDS.filter((b) => where.id.in.includes(b.id))),
    },
    vehicle: { findFirst: () => Promise.resolve(null) },
  };
}

/** A DiscountService that never discounts: every part keeps its own price. */
export const NO_DISCOUNTS = {
  loadActiveSales: () => Promise.resolve([]),
  calculateDiscount: (price: number) => ({
    originalPrice: price,
    finalPrice: price,
    discountAmount: 0,
    discountPercent: 0,
    appliedSale: null,
  }),
};
