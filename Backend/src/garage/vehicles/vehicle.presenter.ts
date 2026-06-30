import { Prisma } from '@prisma/client';

// Relations needed to build the contract's nested vehicle DTO.
export const VEHICLE_INCLUDE = {
  make: true,
  model: true,
  trim: true,
  engine: true,
  model3dAsset: { include: { variants: true } },
} satisfies Prisma.VehicleInclude;

export type VehicleWithRelations = Prisma.VehicleGetPayload<{ include: typeof VEHICLE_INCLUDE }>;

const lower = (v: string | null): string | null => (v ? v.toLowerCase() : null);

/** Map a Vehicle row (with relations) to the contract's nested response shape. */
export function presentVehicle(v: VehicleWithRelations, include3d = true) {
  return {
    id: v.id,
    user_id: v.userId,
    is_primary: v.isPrimary,
    nickname: v.nickname,
    make: v.make ? { id: v.make.id, name: v.make.name, logo_url: v.make.logoUrl } : null,
    model: v.model ? { id: v.model.id, name: v.model.name } : null,
    year: v.year,
    trim: v.trim ? { id: v.trim.id, name: v.trim.name } : null,
    engine: v.engine
      ? {
          id: v.engine.id,
          name: v.engine.name,
          displacement_cc: v.engine.displacementCc,
          fuel_type: lower(v.engine.fuelType),
        }
      : null,
    transmission: lower(v.transmission),
    drivetrain: lower(v.drivetrain),
    color_hex: v.colorHex,
    vin: v.vin,
    license_plate: v.licensePlate,
    registration_region_code: v.registrationRegionCode,
    mileage_km: v.mileageKm,
    fuel_type: lower(v.fuelType),
    model_3d:
      include3d && v.model3dAsset
        ? {
            glb_url: v.model3dAsset.glbUrl,
            ktx2_textures_url: v.model3dAsset.ktx2TexturesUrl,
            tuning_variants: v.model3dAsset.variants.map((t) => ({
              id: t.id,
              name: t.name,
              thumbnail_url: t.thumbnailUrl,
            })),
            version: v.model3dAsset.version,
            byte_size: v.model3dAsset.byteSize,
            checksum_sha256: v.model3dAsset.checksumSha256,
          }
        : null,
    created_at: v.createdAt.toISOString(),
    updated_at: v.updatedAt.toISOString(),
  };
}
