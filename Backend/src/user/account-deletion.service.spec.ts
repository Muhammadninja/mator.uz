// Unit tests for AccountDeletionService (DELETE /v1/me — an App Store
// requirement). Prisma, Cloudinary and TokenService are doubles: no DB, no real
// upload store. These pin the deletion CONTRACT rather than the implementation's
// call order:
//   • every personal-data relation is deleted;
//   • orders are RETAINED, with buyer PII detached/anonymized;
//   • sessions are revoked through the existing TokenService entry point;
//   • the surviving app_users row carries no personal data and is marked deleted;
//   • the Cloudinary avatar is destroyed, by the STORED public id;
//   • external cleanup failures never fail an already-committed deletion;
//   • an order still in progress (or an open Payme payment) refuses deletion
//     with 409 before anything is written.

import { ConflictException, NotFoundException } from '@nestjs/common';
import { OrderStatus, PaymentProvider } from '@prisma/client';
import {
  ACCOUNT_HAS_ACTIVE_ORDERS,
  AccountDeletionService,
} from './account-deletion.service';
import { createPrismaMock, PrismaMock } from '../../test/utils/harness';
import { matchesWhere } from '../catalog/compatibility/where-eval.test-util';
import { PAYME_TRANSACTION_TIMEOUT_MS } from '../orders/webhooks/payme.service';

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

/**
 * The account's orders and payments in memory: `order.count` and
 * `payment.findMany` evaluate the service's REAL where-clauses over them
 * (where-eval), so these tests assert WHICH rows block deletion.
 */
function withOrders(
  prisma: PrismaMock,
  orders: { userId: string; status: OrderStatus }[],
  payments: Record<string, unknown>[] = [],
) {
  prisma.order.count.mockImplementation(({ where }: { where: unknown }) =>
    Promise.resolve(orders.filter((o) => matchesWhere(o, where)).length),
  );
  prisma.payment.findMany.mockImplementation(({ where }: { where: unknown }) =>
    Promise.resolve(payments.filter((p) => matchesWhere(p, where))),
  );
}

/** A Payme payment row of one of USER_ID's orders. */
const paymePayment = (providerState: number, createdMsAgo = 60_000) => ({
  provider: PaymentProvider.PAYME,
  providerState,
  providerCreateTime: BigInt(Date.now() - createdMsAgo),
  order: { userId: USER_ID },
});

const PERSONAL_DATA_MODELS = [
  'cart',
  'booking',
  'notification',
  'notificationPreference',
  'device',
  'aiSession',
  'vehicle',
  'address',
  'authIdentity',
  'emailVerificationToken',
  'myIdVerification',
  'myIdSession',
];

async function refusal(service: AccountDeletionService) {
  const err: unknown = await service.deleteAccount(USER_ID).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConflictException);
  return (err as ConflictException).getResponse();
}

describe('AccountDeletionService — an order in progress blocks deletion', () => {
  it.each([
    OrderStatus.PENDING_PAYMENT,
    OrderStatus.PAID,
    OrderStatus.PROCESSING,
    OrderStatus.SHIPPED,
  ])(
    'a %s order → 409 ACCOUNT_HAS_ACTIVE_ORDERS, and NOTHING is changed',
    async (status) => {
      const { service, prisma, tokens, cloudinary } = build();
      withOrders(prisma, [{ userId: USER_ID, status }]);

      expect(await refusal(service)).toMatchObject({
        code: ACCOUNT_HAS_ACTIVE_ORDERS,
      });

      // The active order keeps its delivery phone and address…
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
      expect(prisma.orderStatusHistory.updateMany).not.toHaveBeenCalled();
      expect(prisma.legalAcceptance.updateMany).not.toHaveBeenCalled();
      // …no personal data is deleted, the account is not anonymized…
      for (const model of PERSONAL_DATA_MODELS) {
        expect(prisma[model].deleteMany).not.toHaveBeenCalled();
      }
      expect(prisma.appUser.update).not.toHaveBeenCalled();
      // …and every session stays alive.
      expect(tokens.revokeAllSessions).not.toHaveBeenCalled();
      expect(tokens.notifySessionsRevoked).not.toHaveBeenCalled();
      expect(cloudinary.deleteAssets).not.toHaveBeenCalled();
    },
  );

  it.each([
    OrderStatus.DELIVERED,
    OrderStatus.CANCELLED,
    OrderStatus.REFUNDED,
    OrderStatus.EXPIRED,
  ])('only %s orders → the existing deletion flow runs', async (status) => {
    const { service, prisma, tokens } = build();
    withOrders(prisma, [{ userId: USER_ID, status }]);

    await service.deleteAccount(USER_ID);

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      data: { contactPhoneE164: null, deliveryAddressId: null },
    });
    expect(tokens.revokeAllSessions).toHaveBeenCalled();
    expect(prisma.appUser.update).toHaveBeenCalled();
  });

  it('no orders at all → the existing deletion flow runs', async () => {
    const { service, prisma } = build();
    withOrders(prisma, []);
    await expect(service.deleteAccount(USER_ID)).resolves.toBeUndefined();
    expect(prisma.appUser.update).toHaveBeenCalled();
  });

  it("only another user's order is active → this account is deleted", async () => {
    const { service, prisma } = build();
    withOrders(prisma, [{ userId: 'usr_other', status: OrderStatus.PAID }]);
    await expect(service.deleteAccount(USER_ID)).resolves.toBeUndefined();
  });

  it('an OPEN Payme transaction (state 1, inside 12 h) blocks even on a cancelled order', async () => {
    const { service, prisma, tokens } = build();
    withOrders(
      prisma,
      [{ userId: USER_ID, status: OrderStatus.CANCELLED }],
      [paymePayment(1)],
    );

    expect(await refusal(service)).toMatchObject({
      code: ACCOUNT_HAS_ACTIVE_ORDERS,
    });
    expect(prisma.appUser.update).not.toHaveBeenCalled();
    expect(tokens.revokeAllSessions).not.toHaveBeenCalled();
  });

  it('expired (past 12 h), performed and cancelled Payme transactions do not block', async () => {
    const { service, prisma } = build();
    withOrders(
      prisma,
      [{ userId: USER_ID, status: OrderStatus.REFUNDED }],
      [
        paymePayment(1, PAYME_TRANSACTION_TIMEOUT_MS + 1),
        paymePayment(2),
        paymePayment(-1),
        paymePayment(-2),
        { ...paymePayment(1), provider: PaymentProvider.CLICK },
      ],
    );
    await expect(service.deleteAccount(USER_ID)).resolves.toBeUndefined();
  });

  it('locks the account row and checks BEFORE the first write', async () => {
    const { service, prisma } = build();
    const steps: string[] = [];
    prisma.$queryRaw.mockImplementation((sql: TemplateStringsArray) => {
      steps.push(sql.join('?').includes('FOR UPDATE') ? 'lock' : 'sql');
      return Promise.resolve([]);
    });
    prisma.order.count.mockImplementation(() => {
      steps.push('check');
      return Promise.resolve(0);
    });
    prisma.order.updateMany.mockImplementation(() => {
      steps.push('first write');
      return Promise.resolve({ count: 0 });
    });

    await service.deleteAccount(USER_ID);

    expect(steps).toEqual(['lock', 'check', 'first write']);
  });
});
