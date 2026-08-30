// Unit tests for AccountDeletionService (DELETE /v1/me — an App Store
// requirement). Prisma, Cloudinary and TokenService are doubles: no DB, no real
// upload store. These pin the deletion CONTRACT rather than the implementation's
// call order:
//   • every personal-data relation is deleted;
//   • orders are RETAINED, with buyer PII detached/anonymized;
//   • sessions are revoked through the existing TokenService entry point;
//   • the surviving app_users row carries no personal data and is marked deleted;
//   • the Cloudinary avatar is destroyed, by the STORED public id;
//   • external cleanup failures never fail an already-committed deletion.

import { NotFoundException } from '@nestjs/common';
import { AccountDeletionService } from './account-deletion.service';
import { createPrismaMock, PrismaMock } from '../../test/utils/harness';

const USER_ID = 'usr_1';

function build(
  user: Record<string, unknown> | null = {
    id: USER_ID,
    deletedAt: null,
    avatarPublicId: 'mator/avatars/abc',
  },
) {
  const prisma: PrismaMock = createPrismaMock();
  prisma.appUser.findUnique.mockResolvedValue(user);
  prisma.appUser.update.mockResolvedValue({ id: USER_ID });

  const cloudinary = { deleteAssets: jest.fn().mockResolvedValue(undefined) };
  const tokens = {
    revokeAllSessions: jest.fn().mockResolvedValue(1),
    notifySessionsRevoked: jest.fn(),
  };

  const service = new AccountDeletionService(
    prisma as never,
    cloudinary as never,
    tokens as never,
  );
  return { service, prisma, cloudinary, tokens };
}

describe('AccountDeletionService', () => {
  it('deletes every user-owned personal-data relation', async () => {
    const { service, prisma } = build();

    await service.deleteAccount(USER_ID);

    // Each of these is personal data with no retention basis. Scoped to the
    // authenticated user — never a client-supplied id.
    const scoped = { where: { userId: USER_ID } };
    expect(prisma.address.deleteMany).toHaveBeenCalledWith(scoped);
    expect(prisma.vehicle.deleteMany).toHaveBeenCalledWith(scoped);
    expect(prisma.notification.deleteMany).toHaveBeenCalledWith(scoped);
    expect(prisma.notificationPreference.deleteMany).toHaveBeenCalledWith(
      scoped,
    );
    expect(prisma.device.deleteMany).toHaveBeenCalledWith(scoped);
    expect(prisma.cart.deleteMany).toHaveBeenCalledWith(scoped);
    expect(prisma.booking.deleteMany).toHaveBeenCalledWith(scoped);
    expect(prisma.aiSession.deleteMany).toHaveBeenCalledWith(scoped);
    expect(prisma.authIdentity.deleteMany).toHaveBeenCalledWith(scoped);
    expect(prisma.emailVerificationToken.deleteMany).toHaveBeenCalledWith(
      scoped,
    );
    expect(prisma.myIdSession.deleteMany).toHaveBeenCalledWith(scoped);
    expect(prisma.myIdVerification.deleteMany).toHaveBeenCalledWith(scoped);
  });

  it('RETAINS orders and only detaches the buyer PII on them', async () => {
    const { service, prisma } = build();

    await service.deleteAccount(USER_ID);

    // The orders themselves are never deleted — they are financial records.
    expect(prisma.order.deleteMany).not.toHaveBeenCalled();
    expect(prisma.orderItem.deleteMany).not.toHaveBeenCalled();
    expect(prisma.payment.deleteMany).not.toHaveBeenCalled();
    expect(prisma.orderStatusHistory.deleteMany).not.toHaveBeenCalled();

    // Buyer phone + delivery address are detached from the retained rows.
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      data: { contactPhoneE164: null, deliveryAddressId: null },
    });
  });

  it('clears the actor-name snapshot only on the buyer’s OWN history entries', async () => {
    const { service, prisma } = build();

    await service.deleteAccount(USER_ID);

    // CUSTOMER-scoped: operator/admin entries name staff and are that action's
    // accountability record, so they must not be touched.
    expect(prisma.orderStatusHistory.updateMany).toHaveBeenCalledWith({
      where: { actorId: USER_ID, actorType: 'CUSTOMER' },
      data: { actorName: null },
    });
  });

  it('RETAINS legal consent but strips its network/device provenance', async () => {
    const { service, prisma } = build();

    await service.deleteAccount(USER_ID);

    // The consent record is the lawful basis for having processed this person's
    // data — it must survive deletion exactly as the order trail does.
    expect(prisma.legalAcceptance.deleteMany).not.toHaveBeenCalled();
    expect(prisma.legalAcceptance.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      data: { ipAddress: null, userAgent: null },
    });
  });

  it('revokes all sessions through the existing TokenService entry point', async () => {
    const { service, tokens } = build();

    await service.deleteAccount(USER_ID);

    // Enlisted in the deletion transaction (second arg = the tx client), so the
    // revocation commits atomically with the anonymization.
    expect(tokens.revokeAllSessions).toHaveBeenCalledWith(
      USER_ID,
      expect.anything(),
    );
    // Listeners fire only AFTER commit — see TokenService's contract.
    expect(tokens.notifySessionsRevoked).toHaveBeenCalledWith(USER_ID);
  });

  it('irreversibly anonymizes the surviving row and marks it deleted', async () => {
    const { service, prisma } = build();

    await service.deleteAccount(USER_ID);

    const call = prisma.appUser.update.mock.calls.at(-1)![0];
    expect(call.where).toEqual({ id: USER_ID });

    // Every personal field is cleared…
    for (const field of [
      'email',
      'passwordHash',
      'phoneE164',
      'displayName',
      'firstName',
      'lastName',
      'avatarUrl',
      'avatarPublicId',
      'thumbnailUrl',
    ]) {
      expect(call.data[field]).toBeNull();
    }
    expect(call.data.emailVerified).toBe(false);
    expect(call.data.phoneVerified).toBe(false);
    expect(call.data.myIdStatus).toBe('NOT_VERIFIED');
    // …and the tombstone marker is what stops it authenticating again.
    expect(call.data.deletedAt).toBeInstanceOf(Date);
  });

  it('destroys the Cloudinary avatar using the STORED public id', async () => {
    const { service, cloudinary } = build();

    await service.deleteAccount(USER_ID);

    expect(cloudinary.deleteAssets).toHaveBeenCalledWith(['mator/avatars/abc']);
  });

  it('skips Cloudinary entirely when the user has no stored avatar id', async () => {
    const { service, cloudinary } = build({
      id: USER_ID,
      deletedAt: null,
      avatarPublicId: null,
    });

    await service.deleteAccount(USER_ID);

    // Never guess an id from the URL — deleting the wrong asset is worse than
    // leaving an orphan behind.
    expect(cloudinary.deleteAssets).not.toHaveBeenCalled();
  });

  it('still succeeds when Cloudinary cleanup fails (DB work already committed)', async () => {
    const { service, cloudinary } = build();
    cloudinary.deleteAssets.mockRejectedValue(new Error('cloudinary down'));

    // The account is gone; an external cleanup failure must not resurrect it.
    await expect(service.deleteAccount(USER_ID)).resolves.toBeUndefined();
  });

  it('404s for an unknown user', async () => {
    const { service } = build(null);
    await expect(service.deleteAccount('ghost')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('404s for an already-deleted account and does not re-anonymize it', async () => {
    const { service, prisma, cloudinary } = build({
      id: USER_ID,
      deletedAt: new Date(),
      avatarPublicId: 'mator/avatars/abc',
    });

    await expect(service.deleteAccount(USER_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.appUser.update).not.toHaveBeenCalled();
    expect(cloudinary.deleteAssets).not.toHaveBeenCalled();
  });
});
