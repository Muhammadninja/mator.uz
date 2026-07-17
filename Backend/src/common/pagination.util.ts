/**
 * Server-side pagination clamps. DTO-level `@Max` validation is a first line of
 * defense, but these helpers enforce the bound at the point a value becomes a
 * Prisma `take` (or an in-memory slice), so a limit can never be exceeded even
 * if a route is reached without DTO validation. Defaults are unchanged: callers
 * still pass their own default via `fallback`; only the ceiling is enforced.
 */

/**
 * Resolve a page-size/limit into a safe integer in [1, max].
 * - `undefined`/`null`/non-finite  → `fallback`
 * - below 1                        → 1
 * - above `max`                    → `max`
 */
export function clampLimit(value: number | undefined | null, fallback: number, max: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  if (n < 1) return 1;
  if (n > max) return max;
  return n;
}

/** Resolve a radius (metres) into a safe integer in [1, max]. */
export function clampRadius(value: number | undefined | null, fallback: number, max: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  if (n < 1) return 1;
  if (n > max) return max;
  return n;
}
