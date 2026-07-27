import { OrderStatus, Prisma } from '@prisma/client';
import {
  VEHICLE_INCLUDE,
  VehicleWithRelations,
} from '../../garage/vehicles/vehicle.presenter';

/**
 * Order statuses that count as "money actually committed" when totalling a
 * user's lifetime spend. An order that was never paid (pending payment,
 * cancelled, expired) is NOT revenue, and a refunded one has been given back —
 * counting either would overstate the figure the operator reads on screen.
 */
const SPEND_STATUSES: OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
];

/** Prisma `select` for an admin user list row. */
export const ADMIN_USER_LIST_SELECT = {
  id: true,
  displayName: true,
  firstName: true,
  lastName: true,
  phoneE164: true,
  email: true,
  createdAt: true,
  _count: { select: { orders: true } },
} satisfies Prisma.AppUserSelect;

/**
 * Prisma `select` for the admin user profile. Deliberately narrow: no
 * passwordHash, no tokenVersion, no auth identities — the admin panel never
 * needs credential material, so it is not selected in the first place rather
 * than stripped afterwards.
 *
 * Addresses and vehicles are NOT selected here: each is its own resource under
 * /v1/admin/users/:id/{addresses,vehicles}, so the profile stays lightweight.
 */
export const ADMIN_USER_DETAIL_SELECT = {
  id: true,
  displayName: true,
  firstName: true,
  lastName: true,
  phoneE164: true,
  phoneVerified: true,
  email: true,
  emailVerified: true,
  avatarUrl: true,
  language: true,
  myIdStatus: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AppUserSelect;

/** Prisma `select` for the standalone addresses resource. */
export const ADMIN_USER_ADDRESS_SELECT = {
  id: true,
  label: true,
  regionCode: true,
  district: true,
  street: true,
  fullText: true,
  lat: true,
  lng: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AddressSelect;

/**
 * Relations for the standalone vehicles resource. Re-exported from the garage
 * presenter rather than redefined, so the admin console and the mobile garage
 * read exactly the same columns and can never drift apart at the query level.
 */
export { VEHICLE_INCLUDE };
export type { VehicleWithRelations };

export type AdminUserListRow = Prisma.AppUserGetPayload<{
  select: typeof ADMIN_USER_LIST_SELECT;
}>;
export type AdminUserDetail = Prisma.AppUserGetPayload<{
  select: typeof ADMIN_USER_DETAIL_SELECT;
}>;
export type AdminUserAddress = Prisma.AddressGetPayload<{
  select: typeof ADMIN_USER_ADDRESS_SELECT;
}>;

/** Aggregate order stats for one user. */
export interface AdminUserStats {
  totalOrders: number;
  totalSpent: number;
  lastOrderAt: Date | null;
}

type NameFields = {
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
};

/**
 * Best available human name: display name, else first+last, else null.
 * Mirrors the identical rule in the admin orders presenter, so the same person
 * never renders under two different names across admin screens.
 */
function customerName(u: NameFields): string | null {
  return (
    u.displayName?.trim() ||
    [u.firstName, u.lastName].filter(Boolean).join(' ').trim() ||
    null
  );
}

export { customerName, SPEND_STATUSES };

export function presentAdminUserRow(
  u: AdminUserListRow,
  stats: { totalSpent: number; lastOrderAt: Date | null },
) {
  return {
    id: u.id,
    name: customerName(u),
    phone: u.phoneE164,
    email: u.email,
    ordersCount: u._count.orders,
    totalSpent: stats.totalSpent,
    lastOrderAt: stats.lastOrderAt ? stats.lastOrderAt.toISOString() : null,
    createdAt: u.createdAt.toISOString(),
  };
}

/**
 * User profile + order summary. Addresses and vehicles are deliberately absent:
 * they are separate resources (see presentAdminUserAddress / presentVehicle).
 */
export function presentAdminUserDetail(
  u: AdminUserDetail,
  stats: AdminUserStats,
) {
  return {
    id: u.id,
    name: customerName(u),
    firstName: u.firstName,
    lastName: u.lastName,
    phone: u.phoneE164,
    phoneVerified: u.phoneVerified,
    email: u.email,
    emailVerified: u.emailVerified,
    avatarUrl: u.avatarUrl,
    language: u.language.toLowerCase(),
    myIdStatus: u.myIdStatus.toLowerCase(),
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
    stats: {
      totalOrders: stats.totalOrders,
      totalSpent: stats.totalSpent,
      lastOrderAt: stats.lastOrderAt ? stats.lastOrderAt.toISOString() : null,
    },
  };
}

/**
 * Garage vehicle in the admin vocabulary: camelCase, like every other
 * /v1/admin/* response.
 *
 * The mobile contract (`presentVehicle` in the garage module) is snake_case and
 * must stay that way — the app depends on it. Rather than fork the query, this
 * re-keys the SAME row shape the garage presenter consumes (VEHICLE_INCLUDE),
 * so both views are fed by one Prisma read and one set of relations. The values
 * themselves are untouched: enums stay lowercased exactly as the garage
 * presenter lowercases them, and no field is added or dropped.
 */
export function presentAdminVehicle(v: VehicleWithRelations) {
  const lower = (x: string | null): string | null => (x ? x.toLowerCase() : null);
  return {
    id: v.id,
    userId: v.userId,
    isPrimary: v.isPrimary,
    nickname: v.nickname,
    make: v.make
      ? { id: v.make.id, name: v.make.name, logoUrl: v.make.logoUrl }
      : null,
    model: v.model ? { id: v.model.id, name: v.model.name } : null,
    year: v.year,
    trim: v.trim ? { id: v.trim.id, name: v.trim.name } : null,
    engine: v.engine
      ? {
          id: v.engine.id,
          name: v.engine.name,
          displacementCc: v.engine.displacementCc,
          fuelType: lower(v.engine.fuelType),
        }
      : null,
    transmission: lower(v.transmission),
    drivetrain: lower(v.drivetrain),
    colorHex: v.colorHex,
    vin: v.vin,
    licensePlate: v.licensePlate,
    registrationRegionCode: v.registrationRegionCode,
    mileageKm: v.mileageKm,
    fuelType: lower(v.fuelType),
    model3d: v.model3dAsset
      ? {
          glbUrl: v.model3dAsset.glbUrl,
          ktx2TexturesUrl: v.model3dAsset.ktx2TexturesUrl,
          tuningVariants: v.model3dAsset.variants.map((t) => ({
            id: t.id,
            name: t.name,
            thumbnailUrl: t.thumbnailUrl,
          })),
          version: v.model3dAsset.version,
          byteSize: v.model3dAsset.byteSize,
          checksumSha256: v.model3dAsset.checksumSha256,
        }
      : null,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}

/** Saved address, in the same shape the order details page uses for shipping. */
export function presentAdminUserAddress(a: AdminUserAddress) {
  const location =
    a.lat != null && a.lng != null ? { lat: a.lat, lng: a.lng } : null;
  return {
    id: a.id,
    label: a.label ?? null,
    city: a.regionCode ?? null,
    district: a.district ?? null,
    street: a.street ?? null,
    addressLine: a.fullText ?? null,
    location,
    isDefault: a.isDefault,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}
