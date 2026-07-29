import { Prisma } from '@prisma/client';

/**
 * Prisma `select` for an admin brand (VehicleMake) row. `_count.models` yields
 * the model count in the same query as the row, so a page of brands costs one
 * read rather than one-per-brand.
 */
export const ADMIN_BRAND_LIST_SELECT = {
  id: true,
  name: true,
  logoUrl: true,
  country: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { models: true } },
} satisfies Prisma.VehicleMakeSelect;

/** Prisma `select` for a model (VehicleModelRef) row. */
export const ADMIN_MODEL_SELECT = {
  id: true,
  makeId: true,
  name: true,
  yearFrom: true,
  yearTo: true,
  bodyType: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.VehicleModelRefSelect;

export type AdminBrandListRow = Prisma.VehicleMakeGetPayload<{
  select: typeof ADMIN_BRAND_LIST_SELECT;
}>;
export type AdminModelRow = Prisma.VehicleModelRefGetPayload<{
  select: typeof ADMIN_MODEL_SELECT;
}>;

/** Brand wire row: camelCase, Dates narrowed to ISO strings. */
export function presentAdminBrandRow(m: AdminBrandListRow) {
  return {
    id: m.id,
    name: m.name,
    logoUrl: m.logoUrl,
    country: m.country,
    isActive: m.isActive,
    modelsCount: m._count.models,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

/** Model wire row: `brandId` is the make id; Dates narrowed to ISO strings. */
export function presentAdminModelRow(m: AdminModelRow) {
  return {
    id: m.id,
    brandId: m.makeId,
    name: m.name,
    yearFrom: m.yearFrom,
    yearTo: m.yearTo,
    bodyType: m.bodyType,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

/**
 * Brand detail projection — strictly a superset of the list row (every list
 * field spread in unchanged) plus the ordered models list, so a client written
 * against the list shape keeps working against this endpoint.
 */
export function presentAdminBrandDetail(
  brand: AdminBrandListRow,
  models: AdminModelRow[],
) {
  return {
    ...presentAdminBrandRow(brand),
    models: models.map(presentAdminModelRow),
  };
}
