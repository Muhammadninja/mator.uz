/**
 * Helpers for keeping personally-identifiable information out of production
 * logs while preserving enough of the value to correlate/debug. Use these
 * whenever a phone number or email would otherwise be written to a logger.
 */

/**
 * Mask an E.164 phone number, keeping the country prefix and the last two
 * digits: "+998901234567" -> "+998*******67". Short/empty values collapse to
 * "***" so nothing sensitive leaks on odd input.
 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '***';
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.length <= 4) return '***';
  const hasPlus = digits.startsWith('+');
  const prefix = digits.slice(0, hasPlus ? 4 : 3); // "+998" or "998"
  const suffix = digits.slice(-2);
  return `${prefix}${'*'.repeat(Math.max(1, digits.length - prefix.length - 2))}${suffix}`;
}

/**
 * Mask an email, keeping the first character of the local part and the full
 * domain: "akmal@example.com" -> "a***@example.com".
 */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '***';
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}
