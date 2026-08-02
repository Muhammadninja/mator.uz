import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { MyIdStatus, OrderActorType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { TokenService } from '../auth/tokens/token.service';

/**
 * Permanent account deletion — DELETE /v1/me.
 *
 * Apple requires any app offering account creation to offer account deletion, so
 * this is a release blocker rather than a nice-to-have. The user's identity comes
 * from the authenticated principal only; no endpoint here accepts a user id from
 * the client.
 *
 * ── The retention decision (documented, deliberate) ─────────────────────────
 * ORDERS ARE RETAINED, WITH BUYER PII ANONYMIZED/DETACHED.
 *
 * Orders are financial records (they have payments against them, feed dealer GMV
 * and settlement, and are subject to accounting retention), so destroying them
 * on request would destroy the other side's books, not just the user's data.
 * `orders.user_id` is NOT NULL with onDelete: Restrict, which encodes exactly
 * that: the schema forbids an order losing its buyer key.
 *
 * That makes a hard DELETE of the app_users row impossible for any user who has
 * ever ordered. Deletion is therefore IRREVERSIBLE ANONYMIZATION of that one row
 * — every personal field overwritten in the same transaction — plus a hard
 * DELETE of every other personal-data relation. What survives is a tombstone
 * holding no personal data, only the key the retained orders point at.
 *
 * Retained (financial/legal):
 *   • orders + order_items + payments + order_status_history — amounts, statuses,
 *     line snapshots and timings, i.e. the money trail.
 *
 * Anonymized or detached on those retained rows:
 *   • orders.contact_phone_e164   → NULL (buyer's phone)
 *   • orders.delivery_address_id  → NULL (detached before the address row is
 *                                  deleted; the FK is SetNull, so this is
 *                                  explicit rather than incidental)
 *   • order_status_history.actor_name → NULL for CUSTOMER entries, i.e. the ones
 *                                  the buyer caused (the snapshotted display
 *                                  name). OPERATOR/ADMIN entries are untouched —
 *                                  they name staff and are that action's
 *                                  accountability record, not buyer PII.
 *
 * Deleted outright (personal data, no retention basis):
 *   • addresses, vehicles (garage) + their status events, bookings, cart + items,
 *     notifications + preferences, devices (push tokens), AI sessions + messages,
 *     auth identities, MyID sessions + verifications (passport/PINFL data),
 *     email verification tokens, refresh tokens.
 *
 * Note there is no favourites/likes table in this schema — the buyer app keeps
 * them client-side — so there is nothing of that kind to delete server-side.
 *
 * ── Ordering and failure strategy ───────────────────────────────────────────
 * The database work runs in ONE transaction: it either fully commits or changes
 * nothing, so the account can never be left half-deleted. Cloudinary is external
 * to Postgres and cannot join that transaction, so it is cleaned up AFTER the
 * commit and is best-effort: a failed asset delete is logged and does not fail a
 * request whose database side already succeeded.
 *
 * That ordering is the safe one. The invariant that matters is "a successful
 * response must mean the account is unusable" — committing first guarantees it.
 * The opposite order could destroy the avatar and then roll the deletion back,
 * leaving a live account with a broken image. The only cost of this direction is
 * a possible orphaned image, which is recoverable; the alternative is not.
 */
@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
    private readonly tokens: TokenService,
  ) {}

  /**
   * Delete the authenticated user's account. Idempotent-ish: a second call
   * cannot happen through the API (the token stops authenticating), but an
   * already-deleted row is treated as gone rather than re-anonymized.
   *
   * @param userId the id of the AUTHENTICATED principal — never a client value.
   */
  async deleteAccount(userId: string): Promise<void> {
    const user = await this.prisma.appUser.findUnique({
      where: { id: userId },
      select: { id: true, deletedAt: true, avatarPublicId: true },
    });
    if (!user || user.deletedAt) throw new NotFoundException('User not found');

    await this.prisma.$transaction(async (tx) => {
      // ── 1. Detach buyer PII from the RETAINED orders ──────────────────────
      // Done BEFORE the addresses are deleted so the detach is explicit and not
      // dependent on the FK's SetNull firing.
      await tx.order.updateMany({
        where: { userId },
        data: { contactPhoneE164: null, deliveryAddressId: null },
      });

      // The actor-name snapshot on the user's own status transitions. Scoped to
      // CUSTOMER entries (the buyer's own actions): an OPERATOR/ADMIN entry names
      // staff, is the accountability record for that action, and is not the
      // deleted buyer's personal data. The entry itself is KEPT — only the name
      // is cleared — so the order's transition history stays complete.
      await tx.orderStatusHistory.updateMany({
        where: { actorId: userId, actorType: OrderActorType.CUSTOMER },
        data: { actorName: null },
      });

      // ── 2. Delete every other personal-data relation ──────────────────────
      // Written explicitly rather than relying on the schema's ON DELETE CASCADE,
      // because the app_users row is NOT deleted — nothing would cascade. Order
      // matters only where a row is a parent of another (cart → items, vehicles →
      // status events, ai sessions → messages), which the DB cascades handle once
      // the parent goes.
      const userScoped = { userId };
      await tx.cart.deleteMany({ where: userScoped });
      await tx.booking.deleteMany({ where: userScoped });
      await tx.notification.deleteMany({ where: userScoped });
      await tx.notificationPreference.deleteMany({ where: userScoped });
      // Push tokens (expo/fcm/apns) live on the device row — deleting it removes
      // them, so there is no separate push-token table to sweep.
      await tx.device.deleteMany({ where: userScoped });
      await tx.aiSession.deleteMany({ where: userScoped });
      await tx.vehicle.deleteMany({ where: userScoped });
      // Addresses go AFTER the orders were detached above, so no retained order
      // is left pointing at a row that is about to disappear.
      await tx.address.deleteMany({ where: userScoped });

      // Authentication/identity material.
      await tx.authIdentity.deleteMany({ where: userScoped });
      await tx.emailVerificationToken.deleteMany({ where: userScoped });
      // MyID verifications hold passport serial/number and PINFL — the most
      // sensitive rows in the schema.
      await tx.myIdVerification.deleteMany({ where: userScoped });
      await tx.myIdSession.deleteMany({ where: userScoped });

      // ── 3. Revoke every session ───────────────────────────────────────────
      // The EXISTING revocation entry point, enlisted in this transaction: it
      // drops the refresh-token family and bumps tokenVersion, which invalidates
      // every access token still in flight (JwtStrategy compares the claim on
      // each request). No parallel blacklist is introduced. The listeners are
      // fired after commit, below.
      await this.tokens.revokeAllSessions(userId, tx);

      // ── 4. Irreversibly anonymize the surviving row ───────────────────────
      // Overwrites, not nulls-where-possible: unique columns (email, phone) are
      // nulled so the person can sign up again with the same address/number, and
      // every free-text personal field is cleared. `deletedAt` is what makes the
      // row unusable for authentication (JwtStrategy rejects it).
      await tx.appUser.update({
        where: { id: userId },
        data: {
          email: null,
          passwordHash: null,
          emailVerified: false,
          phoneE164: null,
          phoneVerified: false,
          displayName: null,
          firstName: null,
          lastName: null,
          avatarUrl: null,
          avatarPublicId: null,
          thumbnailUrl: null,
          myIdStatus: MyIdStatus.NOT_VERIFIED,
          deletedAt: new Date(),
        },
      });
    });

    // Committed. Tell transports holding state across requests (live WebSockets)
    // to drop this user's connections — must happen AFTER commit, since the
    // revocation ran inside the transaction above (see TokenService).
    this.tokens.notifySessionsRevoked(userId);

    // ── 5. External cleanup (outside the transaction, best effort) ──────────
    // Only ever the authenticated user's OWN stored public id — never a value
    // supplied by the client — so this cannot be steered at another user's asset.
    if (user.avatarPublicId) {
      try {
        await this.cloudinary.deleteAssets([user.avatarPublicId]);
      } catch (err) {
        // deleteAssets already swallows per-asset failures; this guards against
        // anything it does not. The account is already deleted and must stay
        // deleted, so a cleanup failure is logged, never rethrown.
        this.logger.warn(
          `Avatar cleanup failed for deleted user ${userId}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    this.logger.log(
      `Account ${userId} deleted (orders retained, PII anonymized)`,
    );
  }
}
