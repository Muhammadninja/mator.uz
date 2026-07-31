import { Prisma, SaleScopeType } from '@prisma/client';

/**
 * Prisma `select` for a sale row. Targets come back as a count on the list (a
 * page of sales costs one query) and in full on the detail view.
 */
export const SALE_LIST_SELECT = {
  id: true,
  title: true,
  description: true,
  discountType: true,
  discountValue: true,
  scopeType: true,
  startAt: true,
  endAt: true,
  isActive: true,
  priority: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { targets: true } },
} satisfies Prisma.SaleSelect;

/** Detail view: the list row plus the resolved target ids. */
export const SALE_DETAIL_SELECT = {
  ...SALE_LIST_SELECT,
  targets: {
    select: { targetType: true, targetId: true },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.SaleSelect;

export type SaleListRow = Prisma.SaleGetPayload<{
  select: typeof SALE_LIST_SELECT;
}>;
export type SaleDetailRow = Prisma.SaleGetPayload<{
  select: typeof SALE_DETAIL_SELECT;
}>;

/**
 * Derived lifecycle state. NOT a stored column: it is a function of `isActive`,
 * `deletedAt` and the clock, so storing it would go stale the moment a sale's
 * window opens or closes with no write to trigger an update. In particular an
 * `expired` sale needs no sweeper job — it reports as expired, and stops being
 * applied, purely because time passed.
 *
 * Precedence, strongest first: `deleted` (terminal) beats `inactive` (the switch
 * is off) beats the window states. So a sale an admin disabled never reads as
 * "active" merely because its dates overlap.
 */
export type SaleLifecycle =
  'active' | 'scheduled' | 'expired' | 'inactive' | 'deleted';

export function saleLifecycle(
  sale: {
    isActive: boolean;
    startAt: Date;
    endAt: Date | null;
    deletedAt?: Date | null;
  },
  now: Date = new Date(),
): SaleLifecycle {
  if (sale.deletedAt) return 'deleted';
  if (!sale.isActive) return 'inactive';
  if (now < sale.startAt) return 'scheduled';
  if (sale.endAt && now > sale.endAt) return 'expired';
  return 'active';
}

/**
 * Money and percentages leave the API as JSON numbers. The columns are Decimal
 * so arithmetic stays exact in the database, but Prisma hands back a
 * Decimal instance that `JSON.stringify` would render as an object.
 *
 * A discount value is a percentage (<= 100) or a UZS amount, both far below
 * Number.MAX_SAFE_INTEGER, so the conversion is exact for every storable value.
 */
function decimalToNumber(value: Prisma.Decimal): number {
  return value.toNumber();
}

/** Admin list row. */
export function presentSaleRow(sale: SaleListRow, now: Date = new Date()) {
  return {
    id: sale.id,
    title: sale.title,
    description: sale.description,
    discountType: sale.discountType,
    discountValue: decimalToNumber(sale.discountValue),
    scopeType: sale.scopeType,
    targetCount: sale._count.targets,
    startAt: sale.startAt.toISOString(),
    endAt: sale.endAt ? sale.endAt.toISOString() : null,
    isActive: sale.isActive,
    priority: sale.priority,
    status: saleLifecycle(sale, now),
    // Null unless the sale was soft-deleted. Present on the admin shape only —
    // the public projection below never exposes it, and never returns a
    // deleted sale at all.
    deletedAt: sale.deletedAt ? sale.deletedAt.toISOString() : null,
    createdAt: sale.createdAt.toISOString(),
    updatedAt: sale.updatedAt.toISOString(),
  };
}

/**
 * Admin detail projection. Strictly a superset of the list row — every list
 * field is spread in unchanged — so a client written against the list shape
 * keeps working against this one.
 */
export function presentSaleDetail(sale: SaleDetailRow, now: Date = new Date()) {
  const { targets, ...listShape } = sale;
  return {
    ...presentSaleRow(listShape, now),
    targetIds: targets.map((t) => t.targetId),
  };
}

/**
 * PUBLIC projection for GET /v1/sales. Narrower than the admin shape — no
 * operational fields (priority, isActive, createdAt/updatedAt) and `status` is
 * omitted since this endpoint only returns active sales — but it DOES expose
 * `targetIds`: a client cannot tell which products a scoped campaign covers
 * without them (a PRODUCTS/CATEGORIES/DEALERS sale is unusable otherwise). Empty
 * for an ALL_PRODUCTS sale, which matches everything by definition. The ids are
 * public catalog/category/dealer ids, so nothing sensitive is exposed.
 */
export function presentPublicSale(sale: SaleDetailRow) {
  return {
    id: sale.id,
    title: sale.title,
    description: sale.description,
    discountType: sale.discountType,
    discountValue: decimalToNumber(sale.discountValue),
    scopeType: sale.scopeType,
    targetIds: (sale.targets ?? []).map((t) => t.targetId),
    startAt: sale.startAt.toISOString(),
    endAt: sale.endAt ? sale.endAt.toISOString() : null,
  };
}

/** Scope kinds that resolve through SaleTarget rows. ALL_PRODUCTS never does. */
export const SCOPED_TARGET_TYPES: readonly SaleScopeType[] = [
  SaleScopeType.PRODUCTS,
  SaleScopeType.CATEGORIES,
  SaleScopeType.DEALERS,
];
