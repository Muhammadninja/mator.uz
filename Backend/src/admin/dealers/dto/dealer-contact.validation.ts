/**
 * Shared by the dealer create and update DTOs.
 *
 * The console clears a contact field by sending an empty string, which the
 * service stores as null. So an empty value is "nothing to validate", exactly
 * like an absent one; anything else must be well formed.
 */
export const isProvided = (_object: unknown, value: unknown): boolean =>
  value !== undefined && value !== null && value !== '';

export const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Operators type a phone the way it is printed: `+998 90 123 45 67`. Spaces,
 * dashes and parentheses are dropped before the E.164 rule is applied, so the
 * stored value is canonical and the form does not have to be.
 */
export const normalizePhone = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.replace(/[\s()-]/g, '') : value;
