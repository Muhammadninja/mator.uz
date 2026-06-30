/**
 * Canonical email normalization, applied at EVERY auth entry point
 * (register, login, Google, Apple, resend). Per the locked architecture
 * decision, uniqueness is enforced at the application layer — NOT via a
 * DB-level lower(email) index — so all reads and writes MUST funnel email
 * through this function to stay consistent.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
