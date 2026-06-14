// Minimal promo engine. Extend with a Promo table when campaigns grow.
const PROMOS: Record<string, number> = {
  MATOR10: 0.1,
};

export interface PromoResult {
  isValid: boolean;
  discountUzs: number;
}

export function resolvePromo(code: string, subtotalUzs: number): PromoResult {
  const pct = PROMOS[code.trim().toUpperCase()];
  if (!pct) return { isValid: false, discountUzs: 0 };
  return { isValid: true, discountUzs: Math.round(subtotalUzs * pct) };
}
