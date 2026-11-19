// Minimal promo engine. Extend with a Promo table when campaigns grow.
// No code is active: MATOR10 was removed on 2026-11-19. A cart still holding
// a removed code has it cleared on its next read (CartService.refreshPromo),
// and checkout discounts nothing for it.
const PROMOS: Record<string, number> = {};

export interface PromoResult {
  isValid: boolean;
  discountUzs: number;
}

export function resolvePromo(code: string, subtotalUzs: number): PromoResult {
  const pct = PROMOS[code.trim().toUpperCase()];
  if (!pct) return { isValid: false, discountUzs: 0 };
  return { isValid: true, discountUzs: Math.round(subtotalUzs * pct) };
}
