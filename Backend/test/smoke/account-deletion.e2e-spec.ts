// End-to-end smoke tests for DELETE /v1/me (account deletion — an App Store
// requirement for any app that supports account creation).
//
// These run the REAL AccountDeletionService, the REAL TokenService and the REAL
// JwtStrategy against the shared Prisma double, so the security claim is
// verified through the actual auth stack rather than asserted on a mock:
//
//   • a valid token authenticates BEFORE deletion;
//   • the SAME token is rejected with 401 AFTER deletion;
//   • the old refresh token cannot mint a new session (401);
//   • the controller answers 204 with no body;
//   • the endpoint acts on the AUTHENTICATED principal, never a client-sent id.

import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AccountDeletionService } from '../../src/user/account-deletion.service';
import { UserController } from '../../src/user/user.controller';
import { JwtStrategy } from '../../src/auth/strategies/jwt.strategy';
import { JwtPayload } from '../../src/auth/interfaces/jwt-payload.interface';
import { TokenService } from '../../src/auth/tokens/token.service';
import { JwtKeyService } from '../../src/auth/tokens/jwt-key.service';
import {
  createPrismaMock,
  fakeConfig,
  fakeRedis,
  buildAppUser,
  PrismaMock,
} from '../utils/harness';

const USER_ID = 'usr_del';

/** Real token stack (ephemeral RS256 keypair) over the Prisma double. */
function realTokens(prisma: PrismaMock) {
  const keys = new JwtKeyService(fakeConfig());
  const redis = fakeRedis();
  const tokens = new TokenService(
    prisma,
    new JwtService({}),
    keys,
    fakeConfig(),
    redis,
  );
  prisma.refreshToken.create.mockResolvedValue({ id: 'rt_row' });
  return { tokens, keys };
}

/** Decode a signed access token back into the payload the strategy receives. */
async function payloadOf(
  token: string,
  keys: JwtKeyService,
): Promise<JwtPayload> {
  const jwt = new JwtService({});
  return jwt.verifyAsync<JwtPayload>(token, {
    publicKey: keys.publicKey,
    algorithms: ['RS256'],
    issuer: 'mator',
    audience: 'mator-app',
  });
}

function build() {
  const prisma: PrismaMock = createPrismaMock();
  const { tokens, keys } = realTokens(prisma);
  const cloudinary = { deleteAssets: jest.fn().mockResolvedValue(undefined) };

  // A LIVE account: this is what every lookup returns until deletion flips it.
  const live = buildAppUser({
    id: USER_ID,
    phoneE164: '+998901234567',
    displayName: 'Aziz',
    avatarPublicId: 'mator/avatars/aziz',
    deletedAt: null,
  });
  prisma.appUser.findUnique.mockResolvedValue(live);
  prisma.appUser.update.mockResolvedValue(live);

  const service = new AccountDeletionService(
    prisma as never,
    cloudinary as never,
    tokens,
  );
  const strategy = new JwtStrategy(fakeConfig(), prisma as never, tokens, keys);

  /** Flip the double so every later lookup sees the anonymized tombstone. */
  const markDeleted = () =>
    prisma.appUser.findUnique.mockResolvedValue(
      buildAppUser({
        id: USER_ID,
        // Anonymized: no personal data survives on the retained row.
        email: null,
        phoneE164: null,
        displayName: null,
        avatarUrl: null,
        avatarPublicId: null,
        tokenVersion: 1, // bumped by revokeAllSessions
        deletedAt: new Date(),
      }),
    );

  return {
    prisma,
    service,
    strategy,
    tokens,
    keys,
    cloudinary,
    live,
    markDeleted,
  };
}

describe('DELETE /v1/me — account deletion smoke', () => {
  it('answers 204 with no body', async () => {
    const { service } = build();
    const controller = new UserController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      service,
    );

    // The handler resolves to undefined; @HttpCode(204) supplies the status.
    await expect(
      controller.deleteMe({ user: { id: USER_ID } }),
    ).resolves.toBeUndefined();
  });

  it('acts on the AUTHENTICATED principal, never a client-supplied id', async () => {
    const { service, prisma } = build();
    const controller = new UserController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      service,
    );

    // Even if a body/param carried another id, the controller only ever passes
    // req.user.id — the id proven by the bearer token.
    await controller.deleteMe({ user: { id: USER_ID } });

    expect(prisma.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID } }),
    );
  });

  it('the SAME access token authenticates before, and 401s after, deletion', async () => {
    const { service, strategy, tokens, keys, markDeleted } = build();

    const session = await tokens.issueSession({
      id: USER_ID,
      email: null,
      role: 'USER',
      tokenVersion: 0,
    });
    const payload = await payloadOf(session.accessToken, keys);

    // Before: the token is good.
    await expect(
      strategy.validate({} as never, payload),
    ).resolves.toMatchObject({
      id: USER_ID,
    });

    await service.deleteAccount(USER_ID);
    markDeleted();

    // After: the very same token is refused. This is the acceptance criterion —
    // a second DELETE /v1/me with the old token must be a 401.
    await expect(
      strategy.validate({} as never, payload),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('the old REFRESH token cannot mint a new session after deletion', async () => {
    const { service, tokens, prisma, markDeleted } = build();

    const session = await tokens.issueSession({
      id: USER_ID,
      email: null,
      role: 'USER',
      tokenVersion: 0,
    });

    await service.deleteAccount(USER_ID);
    markDeleted();

    // Simulate a refresh row that survived the sweep (the race window): it still
    // points at a user who is now deleted.
    prisma.refreshToken.findUnique.mockResolvedValue({
      id: 1,
      tokenHash: 'whatever',
      userId: USER_ID,
      deviceId: null,
      tokenVersion: 0,
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: buildAppUser({
        id: USER_ID,
        tokenVersion: 1,
        deletedAt: new Date(),
      }),
    });

    await expect(tokens.rotate(session.refreshToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    // The stale row is removed rather than left to be replayed.
    expect(prisma.refreshToken.delete).toHaveBeenCalled();
  });

  it('drops the refresh-token family and bumps the session version', async () => {
    const { service, prisma } = build();

    await service.deleteAccount(USER_ID);

    // Through the existing revocation entry point: refresh rows deleted…
    expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
    });
    // …and tokenVersion incremented, which is what kills live access tokens.
    const bump = prisma.appUser.update.mock.calls.find(
      (c: any[]) => c[0]?.data?.tokenVersion,
    );
    expect(bump![0].data.tokenVersion).toEqual({ increment: 1 });
  });

  it('retains orders while stripping the buyer PII from them', async () => {
    const { service, prisma } = build();

    await service.deleteAccount(USER_ID);

    expect(prisma.order.deleteMany).not.toHaveBeenCalled();
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      data: { contactPhoneE164: null, deliveryAddressId: null },
    });
  });

  it('destroys the Cloudinary avatar during deletion', async () => {
    const { service, cloudinary } = build();

    await service.deleteAccount(USER_ID);

    expect(cloudinary.deleteAssets).toHaveBeenCalledWith([
      'mator/avatars/aziz',
    ]);
  });
});
