/**
 * Store-review sign-in: ONE phone number whose login code is fixed and never
 * sent by SMS, so Google Play / App Store reviewers (who have no Uzbek number)
 * can sign in again and again. Every other number keeps the normal SMS login.
 *
 * Off unless both variables are set. The account behind the number is an
 * ordinary customer: it sees only its own garage, cart and orders, never other
 * buyers' data. Only the LOGIN purpose is affected; a phone change to or from
 * this number still goes through SMS.
 *
 *   STORE_REVIEW_PHONE  +998XXXXXXXXX — a number no real customer holds
 *   STORE_REVIEW_CODE   6 digits, not a trivial sequence (000000, 123456, …)
 *
 * The code is a secret: it is given to the stores in their review-access form
 * only. Verification attempts stay rate-limited like any other number.
 */
export const STORE_REVIEW_PHONE_ENV = 'STORE_REVIEW_PHONE';
export const STORE_REVIEW_CODE_ENV = 'STORE_REVIEW_CODE';

export interface StoreReviewLogin {
  phoneE164: string;
  code: string;
}

const PHONE_RE = /^\+998\d{9}$/;
const CODE_RE = /^\d{6}$/;
const TRIVIAL_CODES = new Set(['123456', '654321', '012345', '543210']);

function isTrivial(code: string): boolean {
  return /^(\d)\1{5}$/.test(code) || TRIVIAL_CODES.has(code);
}

/**
 * The configured review login, or null when it is off. A half-set or malformed
 * configuration throws at boot rather than silently doing nothing (or worse,
 * accepting a guessable code).
 */
export function readStoreReviewLogin(
  get: (key: string) => string | undefined,
): StoreReviewLogin | null {
  const phone = get(STORE_REVIEW_PHONE_ENV)?.trim() ?? '';
  const code = get(STORE_REVIEW_CODE_ENV)?.trim() ?? '';
  if (!phone && !code) return null;
  if (!phone || !code) {
    throw new Error(
      `${STORE_REVIEW_PHONE_ENV} and ${STORE_REVIEW_CODE_ENV} must be set together.`,
    );
  }
  if (!PHONE_RE.test(phone)) {
    throw new Error(`${STORE_REVIEW_PHONE_ENV} must look like +998XXXXXXXXX.`);
  }
  if (!CODE_RE.test(code) || isTrivial(code)) {
    throw new Error(
      `${STORE_REVIEW_CODE_ENV} must be 6 digits and not a trivial sequence.`,
    );
  }
  return { phoneE164: phone, code };
}
