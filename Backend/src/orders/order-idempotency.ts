import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';

export const INVALID_IDEMPOTENCY_KEY = 'INVALID_IDEMPOTENCY_KEY';
export const IDEMPOTENCY_KEY_REUSED = 'IDEMPOTENCY_KEY_REUSED';
export const IDEMPOTENCY_KEY_EXPIRED = 'IDEMPOTENCY_KEY_EXPIRED';

/** Letters, digits, `_` and `-`: a UUID, or the app's `ord_<time>_<random>`. */
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/** How long a retry gets the original order back. The app gives up at the same age. */
export const ORDER_IDEMPOTENCY_REPLAY_MS = 30 * 24 * 60 * 60 * 1000;

/** What one checkout attempt is: this buyer, this key, this request. */
export interface OrderIdempotencyClaim {
  userId: string;
  idempotencyKey: string;
  payloadHash: string;
}

type Db = Prisma.TransactionClient;

/**
 * The `Idempotency-Key` header, or null when the client sent none (every build from
 * before this). Anything else that is not a well-formed key is refused rather than
 * ignored: a client that meant to be safe must not silently lose that safety.
 */
export function parseIdempotencyKey(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || !KEY_PATTERN.test(raw)) {
    throw new BadRequestException({
      code: INVALID_IDEMPOTENCY_KEY,
      message: 'Idempotency-Key must be 8 to 128 letters, digits, "_" or "-".',
    });
  }
  return raw;
}

/** JSON with object keys sorted at every level and `undefined` dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/**
 * SHA-256 of the validated checkout request. The request, not the cart: the first
 * attempt consumes the cart, and its retry must still be recognised as the same one.
 */
export function checkoutPayloadHash(dto: object): string {
  return createHash('sha256')
    .update(`order-checkout:v1:${canonicalJson(dto)}`)
    .digest('hex');
}

/**
 * Register the key for the order just created, inside the transaction that created it.
 * A concurrent attempt with the same key that committed first makes this a unique
 * violation, which rolls this whole order back.
 */
export async function recordOrderIdempotency(
  tx: Db,
  claim: OrderIdempotencyClaim,
  orderId: string,
  now: Date = new Date(),
): Promise<void> {
  await tx.orderIdempotency.create({
    data: {
      ...claim,
      orderId,
      expiresAt: new Date(now.getTime() + ORDER_IDEMPOTENCY_REPLAY_MS),
    },
  });
}

/**
 * The order an earlier attempt with this key already placed, or null when there is none.
 * The same key for a different request, or past its replay window, is refused: neither
 * may ever lead to a second order.
 */
export async function findSettledCheckout(
  db: Db,
  claim: OrderIdempotencyClaim,
  now: Date = new Date(),
): Promise<string | null> {
  const row = await db.orderIdempotency.findUnique({
    where: {
      userId_idempotencyKey: {
        userId: claim.userId,
        idempotencyKey: claim.idempotencyKey,
      },
    },
  });
  if (!row) return null;
  if (row.payloadHash !== claim.payloadHash) {
    throw new ConflictException({
      code: IDEMPOTENCY_KEY_REUSED,
      // Shown to the buyer as is: the app has no copy of its own for this code.
      message:
        'An order from this checkout was already placed. Check your orders before ordering again.',
      details: { order_id: row.orderId },
    });
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    throw new ConflictException({
      code: IDEMPOTENCY_KEY_EXPIRED,
      message:
        'This checkout has expired. Check your orders before ordering again.',
      details: { order_id: row.orderId },
    });
  }
  return row.orderId;
}
