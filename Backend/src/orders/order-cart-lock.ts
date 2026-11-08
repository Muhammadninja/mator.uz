import { Prisma } from '@prisma/client';
import { toTiyin } from './service-fee.util';

/** The cart is no longer the one this order was priced from. Rolls the order back. */
export class CartChangedError extends Error {}

/** A snapshot in the locked cart is not the price the order was computed with. */
export class CartSnapshotMovedError extends Error {}

/** What must be identical between the cart an order was priced from and the locked one. */
export interface LockableCartLine {
  id: string;
  partId: string | null;
  offerId: string | null;
  serviceId: string | null;
  quantity: number;
  priceUzsSnapshot: Prisma.Decimal | number;
}

const CART_LINES = {
  items: { include: { offer: { select: { sellerTgId: true } } } },
} satisfies Prisma.CartInclude;

/**
 * Take the cart for this transaction, and read it. The cart row is locked first:
 * a second checkout waits here and then finds the cart already consumed, and a
 * line being added (its foreign key needs the cart row) waits until this order
 * commits, so it lands in the emptied cart instead of being deleted with it. The
 * lines are locked as well, so a quantity edit cannot slip in between this read
 * and their deletion.
 */
export async function lockCart(tx: Prisma.TransactionClient, cartId: string) {
  await tx.$queryRaw`SELECT id FROM carts WHERE id = ${cartId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM cart_items WHERE cart_id = ${cartId} ORDER BY id FOR UPDATE`;
  return tx.cart.findUnique({
    where: { id: cartId },
    include: CART_LINES,
  });
}

/**
 * The order was priced before the transaction, because a delivery quote is a network
 * call that cannot run under a lock. So the locked cart must be that very cart: the
 * same lines in the same quantities with the same promo. Otherwise the buyer confirmed
 * something else. This also stops a second checkout, which finds no lines left.
 */
export function assertSameCart(
  planned: { promoCode: string | null; items: readonly LockableCartLine[] },
  locked: {
    promoCode: string | null;
    items: readonly LockableCartLine[];
  } | null,
): void {
  if (
    !locked ||
    locked.promoCode !== planned.promoCode ||
    locked.items.length !== planned.items.length
  ) {
    throw new CartChangedError();
  }
  const byId = new Map(locked.items.map((line) => [line.id, line]));
  for (const line of planned.items) {
    const now = byId.get(line.id);
    if (
      !now ||
      now.partId !== line.partId ||
      now.offerId !== line.offerId ||
      now.serviceId !== line.serviceId ||
      now.quantity !== line.quantity
    ) {
      throw new CartChangedError();
    }
    if (
      toTiyin(Number(now.priceUzsSnapshot)) !==
      toTiyin(Number(line.priceUzsSnapshot))
    ) {
      throw new CartSnapshotMovedError();
    }
  }
}

/**
 * Delete exactly the lines that were ordered, and prove it. A line added since stays
 * in the cart, and a count that disagrees rolls the order back.
 */
export async function consumeOrderedLines(
  tx: Prisma.TransactionClient,
  cartId: string,
  lineIds: readonly string[],
): Promise<void> {
  const { count } = await tx.cartItem.deleteMany({
    where: { cartId, id: { in: [...lineIds] } },
  });
  if (count !== lineIds.length) throw new CartChangedError();
}
