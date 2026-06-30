import * as argon2 from 'argon2';
import * as bcrypt from 'bcrypt';

/**
 * All new passwords are hashed with Argon2id (OWASP-recommended).
 * Verification stays backward-compatible with legacy bcrypt hashes so
 * existing users created before this change can still log in; their hash
 * is transparently upgraded on next successful login (see AuthService).
 */
export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    if (hash.startsWith('$argon2')) return await argon2.verify(hash, plain);
    if (hash.startsWith('$2')) return await bcrypt.compare(plain, hash); // legacy bcrypt
  } catch {
    return false;
  }
  return false;
}

/** True when a stored hash is a legacy (non-Argon2) hash that should be re-hashed. */
export function needsRehash(hash: string): boolean {
  return !hash.startsWith('$argon2');
}
