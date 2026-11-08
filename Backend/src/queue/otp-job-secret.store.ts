import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { RedisKeys } from '../redis/redis.keys';
import { RedisService } from '../redis/redis.service';

export const OTP_JOB_KEY_ENV = 'OTP_JOB_ENCRYPTION_KEY';

const KEY_BYTES = 32;
const IV_BYTES = 12;

/**
 * The 32-byte key from its env value (64 hex characters, or base64), or null
 * when it is missing or the wrong size. Shared with the boot-time check.
 */
export function parseOtpJobKey(raw: unknown): Buffer | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64');
  return key.length === KEY_BYTES ? key : null;
}

/** Thrown when a stored code cannot be decrypted, or no valid key is configured. */
export class OtpJobSecretError extends Error {}

/**
 * Where an OTP waits for its SMS worker. BullMQ keeps a job's data for as long as
 * the job is retained and shows it in Bull Board, so the job holds only a reference.
 * The code sits under that reference, AES-256-GCM encrypted, for exactly as long as
 * it can be used: when the key lapses in Redis nothing recoverable is left anywhere,
 * however long a failed job is kept.
 *
 * Nothing here falls back to plaintext. With no valid key, sealing throws and no SMS
 * is queued; production refuses to boot without one (see auth-env.config.ts).
 */
@Injectable()
export class OtpJobSecretStore {
  private readonly logger = new Logger(OtpJobSecretStore.name);
  private readonly key: Buffer | null;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.key = parseOtpJobKey(config.get<string>(OTP_JOB_KEY_ENV));
  }

  private requireKey(): Buffer {
    if (!this.key) {
      throw new OtpJobSecretError(`${OTP_JOB_KEY_ENV} is missing or invalid`);
    }
    return this.key;
  }

  /** Store a code until it expires. `ref` and `phone` are bound into the ciphertext. */
  async seal(
    ref: string,
    phone: string,
    code: string,
    expiresAt: number,
  ): Promise<void> {
    const key = this.requireKey();
    const ttlSeconds = Math.ceil((expiresAt - Date.now()) / 1000);
    if (ttlSeconds <= 0) throw new OtpJobSecretError('OTP is already expired');

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`${ref}|${phone}`));
    const body = Buffer.concat([
      cipher.update(JSON.stringify({ code, expiresAt })),
      cipher.final(),
    ]);
    const sealed = [iv, cipher.getAuthTag(), body]
      .map((part) => part.toString('base64'))
      .join('.');
    await this.redis.setEx(RedisKeys.otpSmsSecret(ref), ttlSeconds, sealed);
  }

  /**
   * The code, or null once it has expired or been discarded: there is nothing left
   * worth sending. Throws OtpJobSecretError when the entry cannot be decrypted.
   */
  async open(ref: string, phone: string): Promise<string | null> {
    const sealed = await this.redis.get<string>(RedisKeys.otpSmsSecret(ref));
    if (sealed === null) return null;

    const key = this.requireKey();
    try {
      const [iv, tag, body] = sealed
        .split('.')
        .map((part) => Buffer.from(part, 'base64'));
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(Buffer.from(`${ref}|${phone}`));
      decipher.setAuthTag(tag);
      const { code, expiresAt } = JSON.parse(
        Buffer.concat([decipher.update(body), decipher.final()]).toString(),
      ) as { code: string; expiresAt: number };
      return expiresAt > Date.now() ? code : null;
    } catch {
      // Never the cause: it could quote what it failed on.
      throw new OtpJobSecretError('Stored OTP could not be decrypted');
    }
  }

  /** Drop a code that has been sent. Best effort: its TTL removes it anyway. */
  async discard(ref: string): Promise<void> {
    try {
      await this.redis.del(RedisKeys.otpSmsSecret(ref));
    } catch (err) {
      this.logger.warn(
        `Could not discard a sent OTP (it expires on its own): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
