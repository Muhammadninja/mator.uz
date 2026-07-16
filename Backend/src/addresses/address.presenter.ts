import { Address } from '@prisma/client';

/**
 * Map an Address row to the buyer contract shape (snake_case). Kept identical to
 * the projection used by GET /v1/account/addresses so both endpoints return the
 * same address object; `updated_at` is additionally exposed here (additive).
 */
export function presentAddress(a: Address) {
  return {
    id: a.id,
    label: a.label,
    region_code: a.regionCode,
    district: a.district,
    street: a.street,
    full_text: a.fullText,
    lat: a.lat,
    lng: a.lng,
    is_default: a.isDefault,
    created_at: a.createdAt.toISOString(),
    updated_at: a.updatedAt.toISOString(),
  };
}
