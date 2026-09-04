import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Prefix every issued integration key carries. Purely cosmetic for the server —
 * the guard hashes whatever it is given — but it makes a leaked key instantly
 * recognisable in a log or a paste, which is what makes automated secret
 * scanners (and humans) able to spot one.
 */
export const DEALER_API_KEY_PREFIX = 'mtr_live_';

/** Random bytes behind an issued key. 32 bytes = 256 bits, base64url ≈ 43 chars. */
const KEY_ENTROPY_BYTES = 32;

/**
 * Shortest credential the guard will even hash. A key materially shorter than
 * what {@link generateDealerApiKey} issues is either a truncated paste or an
 * attempt at a guessable value; rejecting it early keeps such attempts off the
 * database entirely.
 */
export const MIN_DEALER_API_KEY_LENGTH = 24;

/** Longest header value accepted. Bounds the work an anonymous caller can force. */
export const MAX_DEALER_API_KEY_LENGTH = 200;

/**
 * Hash an integration key for storage and lookup.
 *
 * Plain SHA-256, deliberately NOT bcrypt/argon2 — the opposite of the choice
 * made for admin passwords, for a reason that matters:
 *
 *   • A password is low-entropy and human-chosen, so it must be slow to hash;
 *     the cost is paid once per login and buys resistance to offline guessing.
 *   • An integration key is 256 bits of CSPRNG output. There is no offline
 *     guessing to resist — the search space is not brute-forceable regardless
 *     of hash speed — and it is presented on EVERY request, including a flood
 *     of invalid ones. A deliberately slow hash there is a denial-of-service
 *     amplifier: an unauthenticated attacker would set our CPU cost per request.
 *
 * Being deterministic is also load-bearing: it is what lets the guard find the
 * dealer with one indexed lookup by digest, instead of bcrypt-comparing the
 * presented key against every dealer row in the table.
 */
export function hashDealerApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

/**
 * Issue a new key. Returns the plaintext — which the caller must show ONCE and
 * never persist — alongside the digest and display suffix that are stored.
 */
export function generateDealerApiKey(): {
  rawKey: string;
  hash: string;
  last4: string;
} {
  const rawKey = `${DEALER_API_KEY_PREFIX}${randomBytes(KEY_ENTROPY_BYTES).toString('base64url')}`;
  return {
    rawKey,
    hash: hashDealerApiKey(rawKey),
    last4: rawKey.slice(-4),
  };
}

/**
 * Constant-time comparison of two hex digests.
 *
 * The lookup itself is by hash, so a mismatch normally ends as "no row found"
 * rather than a comparison. This exists for the final re-check after the read:
 * a plain `===` on secret-derived material short-circuits at the first differing
 * byte, and that timing difference is exactly what a remote attacker measures to
 * recover a value byte by byte. Both digests are fixed-length hex here, so the
 * length check below can never itself leak anything about the secret.
 */
export function safeEqualHex(a: string, b: string): boolean {
  // Reject anything that is not a full-length hex digest BEFORE decoding.
  // `Buffer.from(s, 'hex')` silently stops at the first invalid character, so
  // two different non-hex strings both decode to an empty buffer — and
  // timingSafeEqual reports two empty buffers as EQUAL. Nothing reachable
  // stores a non-hex digest today, but this function exists precisely to be the
  // comparison that cannot be got wrong, so it validates rather than trusting
  // its callers.
  if (!HEX_DIGEST.test(a) || !HEX_DIGEST.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** A SHA-256 digest as stored: exactly 64 lowercase hex characters. */
const HEX_DIGEST = /^[0-9a-f]{64}$/;
