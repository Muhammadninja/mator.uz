// Unit tests for admin token issuance/rotation. Prisma is mocked; the JWT is
// signed for real (@nestjs/jwt + a fixed test secret) so the claims and the
// cross-identity isolation are asserted against actual tokens, not a stub.
//
// These guard the properties the whole admin session model rests on: the refresh
// token is persisted ONLY as a SHA-256 hash, rotation invalidates the presented
// token, replay is treated as compromise (full revocation), a stale token
// version cannot revive a revoked family, a deactivated admin cannot refresh,
// and an admin JWT carries type/role/sub with an audience+algorithm that the
// mobile app's verifier cannot accept.
//
// Multi-device is covered explicitly: logins are INSERTS, so a laptop, a home PC
// and a work PC hold three coexisting sessions that never evict one another, and
// ending one leaves the rest signed in.

import { JwtService } from '@nestjs/jwt';
import { AdminRole } from '@prisma/client';
import { createHash } from 'crypto';
import { ADMIN_JWT_AUDIENCE, ADMIN_JWT_ISSUER } from './admin-auth.config';
import { AdminTokenService } from './admin-token.service';
import { AdminJwtPayload } from './interfaces/admin-jwt-payload.interface';

const SECRET = 'test-admin-secret-at-least-32-characters-long';

function makePrismaMock() {
  const adminRefreshToken = {
    create: jest.fn().mockResolvedValue({}),
    findUnique: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    delete: jest.fn().mockResolvedValue({}),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
  };
  const appAdmin = {
    update: jest.fn().mockResolvedValue({ tokenVersion: 4 }),
  };
  return { adminRefreshToken, appAdmin };
}

const configMock = {
  secret: SECRET,
  accessTtlSeconds: 900,
  refreshTtlSeconds: 604800,
};

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/** First argument of a jest mock's first call, typed by the caller. */
function firstCallArg<T>(fn: jest.Mock): T {
  return (fn.mock.calls as unknown as T[][])[0][0];
}

describe('AdminTokenService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: AdminTokenService;
  const jwt = new JwtService({});

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new AdminTokenService(prisma as never, jwt, configMock as never);
  });

  const subject = { id: 'adm_1', role: AdminRole.SUPER_ADMIN, tokenVersion: 3 };

  function storedRow(over: Record<string, unknown> = {}) {
    return {
      id: 10,
      tokenHash: 'hash',
      adminId: 'adm_1',
      tokenVersion: 3,
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      revokedAt: null,
      deviceName: 'Work PC',
      ip: '203.0.113.7',
      userAgent: 'Firefox',
      admin: {
        id: 'adm_1',
        role: AdminRole.SUPER_ADMIN,
        tokenVersion: 3,
        isActive: true,
      },
      ...over,
    };
  }

  describe('issueSession', () => {
    it('returns the contract triple and an opaque art_ refresh token', async () => {
      const session = await service.issueSession(subject);

      expect(Object.keys(session).sort()).toEqual([
        'accessToken',
        'expiresIn',
        'refreshToken',
      ]);
      expect(session.expiresIn).toBe(900);
      expect(session.refreshToken).toMatch(/^art_[A-Za-z0-9_-]+$/);
    });

    it('persists ONLY the hash of the refresh token, never the raw value', async () => {
      const session = await service.issueSession(subject);

      const { data } = firstCallArg<{
        data: { tokenHash: string; adminId: string; tokenVersion: number };
      }>(prisma.adminRefreshToken.create);
      expect(data.tokenHash).toBe(sha256(session.refreshToken));
      expect(data.tokenHash).not.toContain(session.refreshToken);
      // The row is stamped with the version it was minted under, so a revocation
      // racing this write leaves the row provably stale.
      expect(data.tokenVersion).toBe(3);
      expect(data.adminId).toBe('adm_1');

      const serialized = JSON.stringify(
        firstCallArg<unknown>(prisma.adminRefreshToken.create),
      );
      expect(serialized).not.toContain(session.refreshToken);
    });

    it('signs an access token carrying sub, role and type="admin"', async () => {
      const { accessToken } = await service.issueSession(subject);

      const payload = await jwt.verifyAsync<AdminJwtPayload>(accessToken, {
        secret: SECRET,
        algorithms: ['HS256'],
        issuer: ADMIN_JWT_ISSUER,
        audience: ADMIN_JWT_AUDIENCE,
      });
      expect(payload.sub).toBe('adm_1');
      expect(payload.role).toBe(AdminRole.SUPER_ADMIN);
      expect(payload.type).toBe('admin');
      expect(payload.tokenVersion).toBe(3);
      expect(payload.jti).toEqual(expect.any(String) as string);
    });

    it('carries no password hash or email in the token', async () => {
      const { accessToken } = await service.issueSession(subject);
      const decoded: unknown = jwt.decode(accessToken);
      expect(decoded).not.toHaveProperty('passwordHash');
      expect(decoded).not.toHaveProperty('email');
    });
  });

  describe('isolation from mobile-app tokens', () => {
    it('is rejected by a verifier expecting the mobile audience/algorithm', async () => {
      const { accessToken } = await service.issueSession(subject);

      // The mobile side verifies RS256 with its own key and audience `mator-app`.
      await expect(
        jwt.verifyAsync(accessToken, {
          secret: SECRET,
          algorithms: ['HS256'],
          issuer: 'mator',
          audience: 'mator-app',
        }),
      ).rejects.toThrow();
    });

    it('cannot be verified with a different secret', async () => {
      const { accessToken } = await service.issueSession(subject);
      await expect(
        jwt.verifyAsync(accessToken, {
          secret: `${SECRET}-different`,
          algorithms: ['HS256'],
        }),
      ).rejects.toThrow();
    });
  });

  describe('rotate', () => {
    it('rejects an unknown refresh token', async () => {
      prisma.adminRefreshToken.findUnique.mockResolvedValue(null);
      await expect(service.rotate('art_nope')).rejects.toThrow(
        'Invalid refresh token',
      );
    });

    it('looks the token up by hash, never by raw value', async () => {
      prisma.adminRefreshToken.findUnique.mockResolvedValue(storedRow());
      await service.rotate('art_raw_value');

      const arg = firstCallArg<{ where: { tokenHash: string } }>(
        prisma.adminRefreshToken.findUnique,
      );
      expect(arg.where.tokenHash).toBe(sha256('art_raw_value'));
    });

    it('issues a new pair and consumes the presented token', async () => {
      prisma.adminRefreshToken.findUnique.mockResolvedValue(storedRow());

      const session = await service.rotate('art_old');

      expect(session.refreshToken).toMatch(/^art_/);
      expect(session.refreshToken).not.toBe('art_old');
      // Soft-consumed (kept for reuse detection), guarded on consumedAt still
      // being null so two concurrent rotations cannot both win.
      expect(prisma.adminRefreshToken.updateMany).toHaveBeenCalledWith({
        where: { id: 10, consumedAt: null, revokedAt: null },
        data: { consumedAt: expect.any(Date) as Date },
      });
      expect(prisma.adminRefreshToken.create).toHaveBeenCalled();
    });

    it('treats reuse of a consumed token as compromise and revokes everything', async () => {
      prisma.adminRefreshToken.findUnique.mockResolvedValue(
        storedRow({ consumedAt: new Date() }),
      );

      await expect(service.rotate('art_replayed')).rejects.toThrow(
        'Refresh token reuse detected',
      );
      // Full revocation: refresh family dropped AND the version bumped, so the
      // attacker's access token dies too rather than living out its TTL.
      expect(prisma.adminRefreshToken.deleteMany).toHaveBeenCalledWith({
        where: { adminId: 'adm_1' },
      });
      expect(prisma.appAdmin.update).toHaveBeenCalledWith({
        where: { id: 'adm_1' },
        data: { tokenVersion: { increment: 1 } },
        select: { tokenVersion: true },
      });
      expect(prisma.adminRefreshToken.create).not.toHaveBeenCalled();
    });

    it('rejects a token whose family was revoked (stale version)', async () => {
      prisma.adminRefreshToken.findUnique.mockResolvedValue(
        storedRow({
          tokenVersion: 2,
          admin: {
            id: 'adm_1',
            role: AdminRole.SUPER_ADMIN,
            tokenVersion: 5,
            isActive: true,
          },
        }),
      );

      await expect(service.rotate('art_stale')).rejects.toThrow(
        'Refresh token revoked',
      );
      expect(prisma.adminRefreshToken.delete).toHaveBeenCalledWith({
        where: { id: 10 },
      });
      expect(prisma.adminRefreshToken.create).not.toHaveBeenCalled();
    });

    it('rejects an expired token and deletes the row', async () => {
      prisma.adminRefreshToken.findUnique.mockResolvedValue(
        storedRow({ expiresAt: new Date(Date.now() - 1000) }),
      );

      await expect(service.rotate('art_expired')).rejects.toThrow(
        'Refresh token expired',
      );
      expect(prisma.adminRefreshToken.delete).toHaveBeenCalledWith({
        where: { id: 10 },
      });
    });

    it('refuses to refresh a deactivated admin into a live session', async () => {
      prisma.adminRefreshToken.findUnique.mockResolvedValue(
        storedRow({
          admin: {
            id: 'adm_1',
            role: AdminRole.SUPER_ADMIN,
            tokenVersion: 3,
            isActive: false,
          },
        }),
      );

      await expect(service.rotate('art_deactivated')).rejects.toThrow(
        'Account is deactivated',
      );
      expect(prisma.adminRefreshToken.create).not.toHaveBeenCalled();
    });

    it('treats a lost concurrent-rotation race as reuse', async () => {
      prisma.adminRefreshToken.findUnique.mockResolvedValue(storedRow());
      // The other request consumed the row first: 0 rows updated.
      prisma.adminRefreshToken.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.rotate('art_raced')).rejects.toThrow(
        'Refresh token reuse detected',
      );
      expect(prisma.adminRefreshToken.create).not.toHaveBeenCalled();
    });
  });

  describe('multi-device sessions', () => {
    it('INSERTS a new row per login instead of replacing the previous one', async () => {
      // The property that makes several devices possible: three logins, three
      // rows, no update/delete of the earlier sessions.
      await service.issueSession(subject, { deviceName: 'Laptop' });
      await service.issueSession(subject, { deviceName: 'Home PC' });
      await service.issueSession(subject, { deviceName: 'Work PC' });

      expect(prisma.adminRefreshToken.create).toHaveBeenCalledTimes(3);
      expect(prisma.adminRefreshToken.deleteMany).not.toHaveBeenCalled();
      expect(prisma.adminRefreshToken.updateMany).not.toHaveBeenCalled();
    });

    it('gives every device a distinct refresh token', async () => {
      const a = await service.issueSession(subject, { deviceName: 'Laptop' });
      const b = await service.issueSession(subject, { deviceName: 'Home PC' });
      expect(a.refreshToken).not.toBe(b.refreshToken);
    });

    it('records the device provenance, truncated to the column widths', async () => {
      await service.issueSession(subject, {
        deviceName: 'D'.repeat(200),
        ip: '203.0.113.7',
        userAgent: 'U'.repeat(500),
      });

      const { data } = firstCallArg<{
        data: {
          deviceName: string;
          ip: string;
          userAgent: string;
          lastUsedAt: Date;
        };
      }>(prisma.adminRefreshToken.create);
      // Oversized client input must not overflow the column and fail the login.
      expect(data.deviceName).toHaveLength(120);
      expect(data.userAgent).toHaveLength(400);
      expect(data.ip).toBe('203.0.113.7');
      expect(data.lastUsedAt).toBeInstanceOf(Date);
    });

    it('stores blank/absent metadata as null', async () => {
      await service.issueSession(subject, { deviceName: '   ', ip: null });
      const { data } = firstCallArg<{
        data: {
          deviceName: string | null;
          ip: string | null;
          userAgent: string | null;
        };
      }>(prisma.adminRefreshToken.create);
      expect(data.deviceName).toBeNull();
      expect(data.ip).toBeNull();
      expect(data.userAgent).toBeNull();
    });

    it('carries the device identity across rotation', async () => {
      prisma.adminRefreshToken.findUnique.mockResolvedValue(storedRow());
      await service.rotate('art_old');

      // Rotation must not erase which device a session belongs to.
      const { data } = firstCallArg<{
        data: { deviceName: string; ip: string; userAgent: string };
      }>(prisma.adminRefreshToken.create);
      expect(data.deviceName).toBe('Work PC');
      expect(data.ip).toBe('203.0.113.7');
      expect(data.userAgent).toBe('Firefox');
    });

    it('rejects a deliberately revoked session WITHOUT nuking the other devices', async () => {
      prisma.adminRefreshToken.findUnique.mockResolvedValue(
        storedRow({ revokedAt: new Date() }),
      );

      await expect(service.rotate('art_signed_out')).rejects.toThrow(
        'Refresh token revoked',
      );
      // Crucially NOT treated as theft: no family-wide revocation, no version
      // bump — the admin's laptop and home PC stay signed in.
      expect(prisma.adminRefreshToken.deleteMany).not.toHaveBeenCalled();
      expect(prisma.appAdmin.update).not.toHaveBeenCalled();
    });

    it('revokes one session by id, scoped to its owner', async () => {
      prisma.adminRefreshToken.updateMany.mockResolvedValue({ count: 1 });
      await expect(service.revokeSession('adm_1', 42)).resolves.toBe(true);

      // adminId in the WHERE clause is what stops one admin ending another's
      // session by guessing an id.
      expect(prisma.adminRefreshToken.updateMany).toHaveBeenCalledWith({
        where: { id: 42, adminId: 'adm_1', revokedAt: null },
        data: { revokedAt: expect.any(Date) as Date },
      });
    });

    it("reports false when the session is not the caller's", async () => {
      prisma.adminRefreshToken.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.revokeSession('adm_1', 999)).resolves.toBe(false);
    });

    it('lists only live sessions on the current token version', async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      prisma.adminRefreshToken.findMany = findMany;
      prisma.appAdmin.findUnique = jest
        .fn()
        .mockResolvedValue({ tokenVersion: 3 });

      await service.listSessions('adm_1');

      const arg = firstCallArg<{
        where: Record<string, unknown>;
        select: Record<string, boolean>;
      }>(findMany);
      expect(arg.where).toMatchObject({
        adminId: 'adm_1',
        consumedAt: null,
        revokedAt: null,
        tokenVersion: 3,
      });
      // The hash is the credential's only stored form — it must never be listed.
      expect(arg.select.tokenHash).toBeUndefined();
    });
  });

  describe('revoke', () => {
    it('marks only the presented session revoked, by hash', async () => {
      await service.revoke('art_one');
      expect(prisma.adminRefreshToken.updateMany).toHaveBeenCalledWith({
        where: { tokenHash: sha256('art_one'), revokedAt: null },
        data: { revokedAt: expect.any(Date) as Date },
      });
      // A deliberate logout is not a theft signal — no version bump, and the
      // admin's other devices keep working.
      expect(prisma.appAdmin.update).not.toHaveBeenCalled();
      expect(prisma.adminRefreshToken.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('revokeAllSessions', () => {
    it('drops the family and bumps the session version', async () => {
      await expect(service.revokeAllSessions('adm_1')).resolves.toBe(4);
      expect(prisma.adminRefreshToken.deleteMany).toHaveBeenCalledWith({
        where: { adminId: 'adm_1' },
      });
      expect(prisma.appAdmin.update).toHaveBeenCalledWith({
        where: { id: 'adm_1' },
        data: { tokenVersion: { increment: 1 } },
        select: { tokenVersion: true },
      });
    });
  });
});
