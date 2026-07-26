// Unit tests for AdminJwtStrategy.validate() — the per-request authorization
// checkpoint. Prisma is mocked; validate() is called directly with an
// already-verified payload (signature/issuer/audience are enforced by passport
// before this point and are covered in token-isolation.spec.ts).
//
// The properties under test are the ones that decide how fast a revocation takes
// effect. An access token is stateless, so nothing can "delete" one — the only
// thing standing between a deactivated admin and 15 more minutes of access is
// that this method re-reads the account on EVERY request:
//
//   • isActive is re-read       -> deactivation applies to the very next request
//   • tokenVersion is compared  -> logout-all / password change / refresh reuse
//                                  invalidate live tokens instantly
//   • the returned principal is DB state, not JWT claims -> GET /me reflects
//     renames and role changes immediately, and never serves a stale role
//
// A regression that dropped the DB read (trusting the claims for speed) would
// still pass a naive "login works" test — these tests are what would catch it.

import { UnauthorizedException } from '@nestjs/common';
import { AdminRole } from '@prisma/client';
import type { Request } from 'express';
import { AdminJwtPayload } from '../interfaces/admin-jwt-payload.interface';
import { AdminJwtStrategy } from './admin-jwt.strategy';

function makePrismaMock() {
  return { appAdmin: { findUnique: jest.fn() } };
}

const configMock = {
  secret: 'test-admin-secret-at-least-32-characters-long',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 604800,
};

/** The admin row as the strategy selects it. */
function adminRow(over: Record<string, unknown> = {}) {
  return {
    id: 'adm_1',
    email: 'admin@example.com',
    name: 'Jane Doe',
    role: AdminRole.SUPER_ADMIN,
    isActive: true,
    tokenVersion: 3,
    lastLoginAt: new Date('2026-07-26T10:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  };
}

/** A valid access-token payload, as minted at login. */
function payload(over: Partial<AdminJwtPayload> = {}): AdminJwtPayload {
  return {
    sub: 'adm_1',
    role: AdminRole.SUPER_ADMIN,
    type: 'admin',
    tokenVersion: 3,
    jti: 'jti-1',
    exp: Math.floor(Date.now() / 1000) + 900,
    ...over,
  };
}

describe('AdminJwtStrategy.validate', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let strategy: AdminJwtStrategy;
  let req: Request;

  beforeEach(() => {
    prisma = makePrismaMock();
    strategy = new AdminJwtStrategy(prisma as never, configMock as never);
    req = {} as Request;
  });

  describe('deactivation takes effect immediately', () => {
    it('rejects a still-valid, correctly-signed token once isActive is false', async () => {
      // The scenario: admin logs in, SUPER_ADMIN sets isActive = false, and the
      // admin keeps using the access token they already hold. It must NOT work
      // for the remainder of its 15-minute TTL.
      prisma.appAdmin.findUnique.mockResolvedValue(
        adminRow({ isActive: false }),
      );

      await expect(strategy.validate(req, payload())).rejects.toThrow(
        'Account is deactivated',
      );
    });

    it('re-reads the account from the database on every request', async () => {
      // This is what makes deactivation immediate. If the strategy ever trusted
      // the JWT claims instead, the check above would silently stop working.
      prisma.appAdmin.findUnique.mockResolvedValue(adminRow());

      await strategy.validate(req, payload());
      await strategy.validate(req, payload());
      await strategy.validate(req, payload());

      expect(prisma.appAdmin.findUnique).toHaveBeenCalledTimes(3);
      expect(prisma.appAdmin.findUnique).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: { id: 'adm_1' } }),
      );
    });

    it('stops working mid-session the moment the flag flips', async () => {
      // Same token, two consecutive requests either side of the deactivation.
      const token = payload();
      prisma.appAdmin.findUnique.mockResolvedValueOnce(adminRow());
      await expect(strategy.validate(req, token)).resolves.toMatchObject({
        id: 'adm_1',
      });

      prisma.appAdmin.findUnique.mockResolvedValueOnce(
        adminRow({ isActive: false }),
      );
      await expect(strategy.validate(req, token)).rejects.toThrow(
        'Account is deactivated',
      );
    });

    it('rejects a token whose admin row was deleted outright', async () => {
      prisma.appAdmin.findUnique.mockResolvedValue(null);
      await expect(strategy.validate(req, payload())).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('session versioning', () => {
    it('rejects a token signed under an older session version', async () => {
      // logout-all / password change / refresh-reuse bump tokenVersion; every
      // access token minted before the bump dies on its next request.
      prisma.appAdmin.findUnique.mockResolvedValue(
        adminRow({ tokenVersion: 4 }),
      );

      await expect(
        strategy.validate(req, payload({ tokenVersion: 3 })),
      ).rejects.toThrow('Token revoked');
    });

    it('accepts a token on the current session version', async () => {
      prisma.appAdmin.findUnique.mockResolvedValue(
        adminRow({ tokenVersion: 7 }),
      );

      await expect(
        strategy.validate(req, payload({ tokenVersion: 7 })),
      ).resolves.toMatchObject({ id: 'adm_1' });
    });
  });

  describe('the principal is live database state, not JWT claims', () => {
    it('returns the CURRENT role, not the one baked into the token', async () => {
      // A demotion must take effect at once: serving the token's stale role
      // would keep SUPER_ADMIN powers alive for the rest of the TTL.
      prisma.appAdmin.findUnique.mockResolvedValue(
        adminRow({ role: AdminRole.OPERATOR }),
      );

      const principal = await strategy.validate(
        req,
        payload({ role: AdminRole.SUPER_ADMIN }),
      );

      expect(principal.role).toBe(AdminRole.OPERATOR);
    });

    it('reflects a profile rename without needing a new token', async () => {
      prisma.appAdmin.findUnique.mockResolvedValue(
        adminRow({ name: 'Renamed Person', email: 'new@example.com' }),
      );

      const principal = await strategy.validate(req, payload());

      expect(principal.name).toBe('Renamed Person');
      expect(principal.email).toBe('new@example.com');
    });

    it('exposes exactly the GET /me fields and no secret material', async () => {
      // req.user IS the /me response body, so its shape is the API contract.
      prisma.appAdmin.findUnique.mockResolvedValue(adminRow());

      const principal = await strategy.validate(req, payload());

      expect(Object.keys(principal).sort()).toEqual([
        'createdAt',
        'email',
        'id',
        'isActive',
        'lastLoginAt',
        'name',
        'role',
      ]);
      // tokenVersion is internal bookkeeping and must not reach the response.
      expect(principal).not.toHaveProperty('tokenVersion');
      expect(principal).not.toHaveProperty('passwordHash');
    });

    it('never selects the password hash in the first place', async () => {
      prisma.appAdmin.findUnique.mockResolvedValue(adminRow());
      await strategy.validate(req, payload());

      const arg = (
        prisma.appAdmin.findUnique.mock.calls as unknown as {
          select: Record<string, boolean>;
        }[][]
      )[0][0];
      expect(arg.select.passwordHash).toBeUndefined();
    });
  });

  describe('token type discriminator', () => {
    it('rejects a payload without type="admin"', async () => {
      await expect(
        strategy.validate(req, payload({ type: 'user' as 'admin' })),
      ).rejects.toThrow('Not an admin token');
      // Rejected before any DB work.
      expect(prisma.appAdmin.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('token metadata', () => {
    it('stashes jti/exp on the request without touching req.user', async () => {
      prisma.appAdmin.findUnique.mockResolvedValue(adminRow());

      const principal = await strategy.validate(
        req,
        payload({ jti: 'jti-xyz', exp: 1893456000 }),
      );

      expect(
        (req as Request & { adminTokenMeta?: { jti?: string; exp?: number } })
          .adminTokenMeta,
      ).toEqual({ jti: 'jti-xyz', exp: 1893456000 });
      expect(principal).not.toHaveProperty('jti');
    });
  });
});
