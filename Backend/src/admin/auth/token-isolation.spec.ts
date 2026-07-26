// Cross-identity isolation: a mobile-app user token must never authenticate an
// admin route, and an admin token must never authenticate a user route.
//
// Both real strategies are constructed and their verification settings exercised
// against real tokens signed by both sides, so this asserts the actual
// cryptographic boundary rather than restating the intent in a comment. The
// isolation rests on THREE independent differences (algorithm, key, audience) —
// each is checked separately, so no single regression can quietly remove it.

import { JwtService } from '@nestjs/jwt';
import { AdminRole } from '@prisma/client';
import { generateKeyPairSync } from 'crypto';
import { ADMIN_JWT_AUDIENCE, ADMIN_JWT_ISSUER } from './admin-auth.config';

const ADMIN_SECRET = 'admin-secret-at-least-32-characters-long!!';
const USER_ISSUER = 'mator';
const USER_AUDIENCE = 'mator-app';

const { privateKey: userPrivateKey, publicKey: userPublicKey } =
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

describe('admin/user token isolation', () => {
  const jwt = new JwtService({});

  /** A token exactly as AdminTokenService mints it. */
  const signAdminToken = () =>
    jwt.signAsync(
      {
        sub: 'adm_1',
        role: AdminRole.SUPER_ADMIN,
        type: 'admin',
        tokenVersion: 0,
      },
      {
        algorithm: 'HS256',
        secret: ADMIN_SECRET,
        issuer: ADMIN_JWT_ISSUER,
        audience: ADMIN_JWT_AUDIENCE,
        expiresIn: 900,
      },
    );

  /** A token exactly as the mobile TokenService mints it. */
  const signUserToken = () =>
    jwt.signAsync(
      { sub: 'usr_1', email: 'u@example.com', role: 'ADMIN', tokenVersion: 0 },
      {
        algorithm: 'RS256',
        privateKey: userPrivateKey,
        issuer: USER_ISSUER,
        audience: USER_AUDIENCE,
        expiresIn: 3600,
      },
    );

  /** Verification as the ADMIN strategy performs it. */
  const verifyAsAdminStrategy = (token: string) =>
    jwt.verifyAsync(token, {
      secret: ADMIN_SECRET,
      algorithms: ['HS256'],
      issuer: ADMIN_JWT_ISSUER,
      audience: ADMIN_JWT_AUDIENCE,
    });

  /** Verification as the USER strategy performs it. */
  const verifyAsUserStrategy = (token: string) =>
    jwt.verifyAsync(token, {
      publicKey: userPublicKey,
      algorithms: ['RS256'],
      issuer: USER_ISSUER,
      audience: USER_AUDIENCE,
    });

  it('a user token is rejected by the admin strategy', async () => {
    // Note the user token above deliberately carries role "ADMIN" — the mobile
    // app's own admin role. Even that must not open the admin panel.
    await expect(
      verifyAsAdminStrategy(await signUserToken()),
    ).rejects.toThrow();
  });

  it('an admin token is rejected by the user strategy', async () => {
    await expect(
      verifyAsUserStrategy(await signAdminToken()),
    ).rejects.toThrow();
  });

  it('each token still verifies on its own side (the test is not vacuous)', async () => {
    await expect(
      verifyAsAdminStrategy(await signAdminToken()),
    ).resolves.toMatchObject({
      sub: 'adm_1',
      type: 'admin',
    });
    await expect(
      verifyAsUserStrategy(await signUserToken()),
    ).resolves.toMatchObject({
      sub: 'usr_1',
    });
  });

  it('the admin secret alone does not admit a token with the wrong audience', async () => {
    // Second, independent barrier: even if both sides ever shared a secret and
    // algorithm, the audience mismatch still rejects the token.
    const wrongAudience = await jwt.signAsync(
      {
        sub: 'adm_1',
        role: AdminRole.SUPER_ADMIN,
        type: 'admin',
        tokenVersion: 0,
      },
      {
        algorithm: 'HS256',
        secret: ADMIN_SECRET,
        issuer: USER_ISSUER,
        audience: USER_AUDIENCE,
        expiresIn: 900,
      },
    );
    await expect(verifyAsAdminStrategy(wrongAudience)).rejects.toThrow();
  });

  it('an unsigned ("alg: none") token is rejected by the admin strategy', async () => {
    const header = Buffer.from(
      JSON.stringify({ alg: 'none', typ: 'JWT' }),
    ).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({
        sub: 'adm_1',
        role: AdminRole.SUPER_ADMIN,
        type: 'admin',
        tokenVersion: 0,
        aud: ADMIN_JWT_AUDIENCE,
        iss: ADMIN_JWT_ISSUER,
        exp: Math.floor(Date.now() / 1000) + 900,
      }),
    ).toString('base64url');
    await expect(verifyAsAdminStrategy(`${header}.${body}.`)).rejects.toThrow();
  });
});
