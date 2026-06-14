import { Prisma } from '@prisma/client';

export const PROVIDER_NEARBY_INCLUDE = {
  specializations: true,
  supportedMakes: true,
  workingHours: true,
} satisfies Prisma.ServiceProviderInclude;
export type ProviderNearby = Prisma.ServiceProviderGetPayload<{ include: typeof PROVIDER_NEARBY_INCLUDE }>;

export const PROVIDER_DETAIL_INCLUDE = {
  specializations: true,
  supportedMakes: true,
  workingHours: { orderBy: { weekday: 'asc' } },
  certifications: true,
  portfolio: { orderBy: { sortOrder: 'asc' } },
  services: true,
} satisfies Prisma.ServiceProviderInclude;
export type ProviderDetail = Prisma.ServiceProviderGetPayload<{ include: typeof PROVIDER_DETAIL_INCLUDE }>;

/** Is the provider open at `now` (Asia/Tashkent), per its working hours? */
export function isOpenNow(hours: ProviderNearby['workingHours'], now: Date): boolean {
  // Shift to UTC+5 (Asia/Tashkent has no DST).
  const tashkent = new Date(now.getTime() + 5 * 60 * 60 * 1000);
  const weekday = tashkent.getUTCDay();
  const hhmm = `${String(tashkent.getUTCHours()).padStart(2, '0')}:${String(tashkent.getUTCMinutes()).padStart(2, '0')}`;
  const today = hours.find((h) => h.weekday === weekday);
  if (!today?.openTime || !today?.closeTime) return false;
  return hhmm >= today.openTime && hhmm <= today.closeTime;
}

export function presentNearby(p: ProviderNearby, distanceM: number, now: Date) {
  return {
    id: p.id,
    type: p.providerType.toLowerCase(),
    display_name: p.displayName,
    shop_name: p.shopName,
    avatar_url: p.avatarUrl,
    rating_avg: Number(p.ratingAvg),
    rating_count: p.ratingCount,
    specializations: p.specializations.map((s) => s.specialization.toLowerCase()),
    supported_makes: p.supportedMakes.map((m) => m.makeId),
    geo: { lat: p.geoLat, lng: p.geoLng, geohash: p.geohash },
    distance_m: distanceM,
    address_text: p.addressText,
    is_open_now: isOpenNow(p.workingHours, now),
    next_open_at: null,
    price_floor_uzs: p.priceFloorUzs != null ? Number(p.priceFloorUzs) : null,
    price_ceiling_uzs: p.priceCeilingUzs != null ? Number(p.priceCeilingUzs) : null,
    badge: p.badge,
  };
}

export function presentDetail(p: ProviderDetail) {
  return {
    id: p.id,
    type: p.providerType.toLowerCase(),
    shop_name: p.shopName,
    display_name: p.displayName,
    bio: p.bio,
    rating_avg: Number(p.ratingAvg),
    rating_count: p.ratingCount,
    certifications: p.certifications.map((c) => ({
      id: c.id,
      name: c.name,
      issued_at: c.issuedAt ? c.issuedAt.toISOString().slice(0, 10) : null,
    })),
    portfolio: p.portfolio.map((i) => ({ id: i.id, image_url: i.imageUrl })),
    services: p.services.map((s) => ({
      id: s.id,
      name: s.name,
      duration_min: s.durationMin,
      price_uzs: Number(s.priceUzs),
    })),
    working_hours: p.workingHours.map((h) => ({
      weekday: h.weekday,
      open: h.openTime,
      close: h.closeTime,
    })),
    contact: {
      phone_e164: p.contactPhoneE164,
      telegram_username: p.contactTelegram,
      website_url: p.contactWebsite,
    },
    geo: { lat: p.geoLat, lng: p.geoLng, address_text: p.addressText },
  };
}
