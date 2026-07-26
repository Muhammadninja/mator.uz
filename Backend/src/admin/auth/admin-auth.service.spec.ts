// Unit tests for admin-panel login (POST /v1/auth/admin/login). Prisma and the
// token service are mocked — no DB, no real JWTs. These guard the security
// properties that are easy to regress: identical failure for unknown email vs
// wrong password (no admin enumeration), the KDF running even when the email is
// unknown (no timing oracle), the isActive gate, the lastLoginAt stamp (and that
// a failure to write it cannot break a valid login), transparent upgrade of a
// legacy bcrypt hash to Argon2id, and that no password/hash ever reaches the
// logger or the response.
//
// Passwords are hashed with the shared Argon2id utility (src/auth/password.util),
// NOT a separate bcrypt policy — bcrypt appears here only as a legacy hash the
// verifier must still accept and upgrade.

import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { AdminAuditAction, AdminRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { hashPassword, verifyPassword } from '../../auth/password.util';
import { AdminAuthService } from './admin-auth.service';

function makePrismaMock() {
  const appAdmin = {
    findUnique: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
    create: jest.fn(),
    delete: jest.fn().mockResolvedValue({}),
  };
  const prisma = { appAdmin } as Record<string, unknown>;
  // Callback form: hand the same mock back as the transaction client, so the
  // assertions can inspect writes made inside a $transaction.
  prisma.$transaction = (arg: unknown) =>
    Array.isArray(arg)
      ? Promise.all(arg)
      : (arg as (tx: unknown) => unknown)(prisma);
  return prisma as unknown as {
    appAdmin: typeof appAdmin;
    $transaction: (arg: unknown) => unknown;
  };
}

function makeAuditMock() {
  return {
    record: jest.fn().mockResolvedValue(undefined),
    list: jest.fn().mockResolvedValue({ items: [], total: 0 }),
  };
}

function makeTokensMock() {
  return {
    issueSession: jest.fn().mockResolvedValue({
      accessToken: 'access.jwt',
      refreshToken: 'art_raw',
      expiresIn: 900,
    }),
    rotate: jest.fn(),
    revoke: jest.fn().mockResolvedValue(undefined),
    revokeAllSessions: jest.fn().mockResolvedValue(1),
    listSessions: jest.fn().mockResolvedValue([]),
    revokeSession: jest.fn().mockResolvedValue(true),
  };
}

/** First argument of a jest mock's first call, typed by the caller. */
function firstCallArg<T>(fn: jest.Mock): T {
  return (fn.mock.calls as unknown as T[][])[0][0];
}

/** Every prisma `update` arg that wrote a passwordHash. */
function passwordHashWrites(
  update: jest.Mock,
): { data: { passwordHash: string } }[] {
  const calls = update.mock.calls as unknown as {
    data?: { passwordHash?: string };
  }[][];
  return calls
    .map((call) => call[0])
    .filter(
      (arg): arg is { data: { passwordHash: string } } =>
        typeof arg?.data?.passwordHash === 'string',
    );
}

const PASSWORD = 'correct-horse-battery';

describe('AdminAuthService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let tokens: ReturnType<typeof makeTokensMock>;
  let audit: ReturnType<typeof makeAuditMock>;
  let service: AdminAuthService;
  let passwordHash: string;
  let legacyBcryptHash: string;

  beforeAll(async () => {
    // The real Argon2id hash the app now produces.
    passwordHash = await hashPassword(PASSWORD);
    // A legacy bcrypt hash, for the backward-compatibility/upgrade tests.
    legacyBcryptHash = await bcrypt.hash(PASSWORD, 4);
  });

  beforeEach(() => {
    prisma = makePrismaMock();
    tokens = makeTokensMock();
    audit = makeAuditMock();
    service = new AdminAuthService(
      prisma as never,
      tokens as never,
      audit as never,
    );
  });

  function activeAdmin(over: Record<string, unknown> = {}) {
    return {
      id: 'adm_1',
      passwordHash,
      role: AdminRole.SUPER_ADMIN,
      isActive: true,
      tokenVersion: 3,
      ...over,
    };
  }

  describe('login', () => {
    it('issues a session for valid credentials and stamps lastLoginAt', async () => {
      prisma.appAdmin.findUnique.mockResolvedValue(activeAdmin());

      const result = await service.login({
        email: 'admin@example.com',
        password: PASSWORD,
      });

      expect(result).toEqual({
        accessToken: 'access.jwt',
        refreshToken: 'art_raw',
        expiresIn: 900,
      });
      // The session is minted from the CURRENT token version, so a revocation
      // that already happened cannot be out-run by logging in again.
      expect(tokens.issueSession).toHaveBeenCalledWith(
        { id: 'adm_1', role: AdminRole.SUPER_ADMIN, tokenVersion: 3 },
        expect.anything(),
      );
      expect(prisma.appAdmin.update).toHaveBeenCalledWith({
        where: { id: 'adm_1' },
        data: { lastLoginAt: expect.any(Date) as Date },
      });
    });

    it('rejects a wrong password without issuing anything', async () => {
      prisma.appAdmin.findUnique.mockResolvedValue(activeAdmin());

      await expect(
        service.login({
          email: 'admin@example.com',
          password: 'wrong-password',
        }),
      ).rejects.toThrow(UnauthorizedException);
      expect(tokens.issueSession).not.toHaveBeenCalled();
      expect(prisma.appAdmin.update).not.toHaveBeenCalled();
    });

    it('reports an unknown email exactly like a wrong password (no enumeration)', async () => {
      prisma.appAdmin.findUnique.mockResolvedValue(null);
      const unknownEmail = await service
        .login({ email: 'nobody@example.com', password: PASSWORD })
        .catch((e: Error) => e);

      prisma.appAdmin.findUnique.mockResolvedValue(activeAdmin());
      const wrongPassword = await service
        .login({ email: 'admin@example.com', password: 'wrong-password' })
        .catch((e: Error) => e);

      expect((unknownEmail as Error).message).toBe(
        (wrongPassword as Error).message,
      );
      expect((unknownEmail as Error).message).toBe('Invalid email or password');
    });

    it('still spends KDF work when the email is unknown (no timing oracle)', async () => {
      // The KDF is a native binding and cannot be spied on, so this asserts the
      // observable property directly: the unknown-email path must not return
      // "instantly" relative to the wrong-password path, which is exactly what
      // an enumeration attack measures. The dummy hash uses the same Argon2id
      // parameters as a real one, so the two paths cost the same. A generous
      // floor keeps this stable on a loaded CI box.
      const time = async (fn: () => Promise<unknown>) => {
        const started = process.hrtime.bigint();
        await fn().catch(() => undefined);
        return Number(process.hrtime.bigint() - started) / 1e6; // ms
      };

      prisma.appAdmin.findUnique.mockResolvedValue(null);
      const unknownEmailMs = await time(() =>
        service.login({ email: 'nobody@example.com', password: PASSWORD }),
      );

      // A short-circuit return would be sub-millisecond; a real Argon2id
      // verification is tens of milliseconds.
      expect(unknownEmailMs).toBeGreaterThan(5);
    });

    it('compares against a well-formed dummy hash rather than throwing', async () => {
      // A malformed dummy would make the verifier reject, turning the
      // unknown-email path into a 500 (and a different observable response).
      prisma.appAdmin.findUnique.mockResolvedValue(null);
      await expect(
        service.login({ email: 'nobody@example.com', password: PASSWORD }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('accepts a legacy bcrypt hash (no admin is locked out by the switch)', async () => {
      prisma.appAdmin.findUnique.mockResolvedValue(
        activeAdmin({ passwordHash: legacyBcryptHash }),
      );

      await expect(
        service.login({ email: 'admin@example.com', password: PASSWORD }),
      ).resolves.toMatchObject({ accessToken: 'access.jwt' });
    });

    it('transparently upgrades a legacy bcrypt hash to Argon2id on login', async () => {
      prisma.appAdmin.findUnique.mockResolvedValue(
        activeAdmin({ passwordHash: legacyBcryptHash }),
      );

      await service.login({ email: 'admin@example.com', password: PASSWORD });

      const upgrades = passwordHashWrites(prisma.appAdmin.update);
      expect(upgrades).toHaveLength(1);
      const { data } = upgrades[0];
      expect(data.passwordHash).toMatch(/^\$argon2id\$/);
      await expect(verifyPassword(data.passwordHash, PASSWORD)).resolves.toBe(
        true,
      );
    });

    it('does not rewrite a hash that is already Argon2id', async () => {
      prisma.appAdmin.findUnique.mockResolvedValue(activeAdmin());

      await service.login({ email: 'admin@example.com', password: PASSWORD });

      expect(passwordHashWrites(prisma.appAdmin.update)).toHaveLength(0);
    });

    it('still logs in if the hash upgrade write fails', async () => {
      prisma.appAdmin.findUnique.mockResolvedValue(
        activeAdmin({ passwordHash: legacyBcryptHash }),
      );
      prisma.appAdmin.update.mockRejectedValue(new Error('db down'));

      // The password already verified — a failed re-hash must not cost the
      // admin their session.
      await expect(
        service.login({ email: 'admin@example.com', password: PASSWORD }),
      ).resolves.toMatchObject({ accessToken: 'access.jwt' });
    });

    it('refuses a deactivated admin even with the right password', async () => {
      prisma.appAdmin.findUnique.mockResolvedValue(
        activeAdmin({ isActive: false }),
      );

      await expect(
        service.login({ email: 'admin@example.com', password: PASSWORD }),
      ).rejects.toThrow('Account is deactivated');
      expect(tokens.issueSession).not.toHaveBeenCalled();
    });

    it('logs in successfully even if the lastLoginAt write fails', async () => {
      prisma.appAdmin.findUnique.mockResolvedValue(activeAdmin());
      prisma.appAdmin.update.mockRejectedValue(new Error('db down'));

      await expect(
        service.login({ email: 'admin@example.com', password: PASSWORD }),
      ).resolves.toMatchObject({ accessToken: 'access.jwt' });
    });

    it('never writes a password, hash or token to the logger', async () => {
      const logs: string[] = [];
      for (const level of ['log', 'warn', 'error', 'debug'] as const) {
        jest
          .spyOn(service['logger'], level)
          .mockImplementation(
            (...args: unknown[]) => void logs.push(args.map(String).join(' ')),
          );
      }

      prisma.appAdmin.findUnique.mockResolvedValue(activeAdmin());
      await service.login({ email: 'admin@example.com', password: PASSWORD });
      await service
        .login({ email: 'admin@example.com', password: 'wrong-password' })
        .catch(() => undefined);
      prisma.appAdmin.findUnique.mockResolvedValue(
        activeAdmin({ isActive: false }),
      );
      await service
        .login({ email: 'admin@example.com', password: PASSWORD })
        .catch(() => undefined);

      const combined = logs.join('\n');
      expect(combined).not.toContain(PASSWORD);
      expect(combined).not.toContain('wrong-password');
      expect(combined).not.toContain(passwordHash);
      expect(combined).not.toContain('art_raw');
      expect(combined).not.toContain('access.jwt');
    });
  });

  describe('login response', () => {
    it('returns only the token triple — no admin record, no hash', async () => {
      prisma.appAdmin.findUnique.mockResolvedValue(activeAdmin());
      const result = await service.login({
        email: 'admin@example.com',
        password: PASSWORD,
      });
      expect(Object.keys(result).sort()).toEqual([
        'accessToken',
        'expiresIn',
        'refreshToken',
      ]);
    });
  });

  describe('logout', () => {
    it('revokes only the presented refresh token', async () => {
      await service.logout('art_raw');
      expect(tokens.revoke).toHaveBeenCalledWith('art_raw');
      // Not a theft signal — other sessions must survive a deliberate logout.
      expect(tokens.revokeAllSessions).not.toHaveBeenCalled();
    });
  });

  describe('sessions (multi-device)', () => {
    it('passes the session context through to the token service on login', async () => {
      prisma.appAdmin.findUnique.mockResolvedValue(activeAdmin());

      await service.login(
        { email: 'admin@example.com', password: PASSWORD },
        { deviceName: 'Work PC', ip: '203.0.113.7', userAgent: 'Firefox' },
      );

      expect(tokens.issueSession).toHaveBeenCalledWith(expect.anything(), {
        deviceName: 'Work PC',
        ip: '203.0.113.7',
        userAgent: 'Firefox',
      });
    });

    it('lists sessions for the calling admin only', async () => {
      await service.listSessions('adm_1');
      expect(tokens.listSessions).toHaveBeenCalledWith('adm_1');
    });

    it('revokes one session scoped to the calling admin', async () => {
      await service.revokeSession('adm_1', 42);
      // adminId is passed down, so one admin can never end another's session.
      expect(tokens.revokeSession).toHaveBeenCalledWith('adm_1', 42);
    });

    it("reports a session that is missing or not the caller's as 404", async () => {
      tokens.revokeSession.mockResolvedValue(false);
      await expect(service.revokeSession('adm_1', 999)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('createAdmin', () => {
    it('stores an Argon2id hash, never the plaintext, and lowercases the email', async () => {
      prisma.appAdmin.create.mockImplementation(
        (args: { data: Record<string, unknown> }) =>
          Promise.resolve({
            id: 'adm_2',
            email: args.data.email,
            name: args.data.name,
            role: args.data.role,
          }),
      );

      await service.createAdmin({
        email: '  Admin@Example.COM ',
        password: PASSWORD,
        name: '  Jane Doe ',
        role: AdminRole.MANAGER,
      });

      const { data } = firstCallArg<{
        data: {
          email: string;
          name: string;
          passwordHash: string;
          role: AdminRole;
        };
      }>(prisma.appAdmin.create);
      expect(data.email).toBe('admin@example.com');
      expect(data.name).toBe('Jane Doe');
      expect(data.role).toBe(AdminRole.MANAGER);
      expect(data.passwordHash).not.toBe(PASSWORD);
      // Argon2id, matching the project-wide password utility.
      expect(data.passwordHash).toMatch(/^\$argon2id\$/);
      await expect(verifyPassword(data.passwordHash, PASSWORD)).resolves.toBe(
        true,
      );
    });

    it('defaults to the least-privileged role', async () => {
      prisma.appAdmin.create.mockResolvedValue({
        id: 'adm_3',
        email: 'x@y.z',
        name: 'X',
        role: AdminRole.OPERATOR,
      });
      await service.createAdmin({
        email: 'x@y.z',
        password: PASSWORD,
        name: 'X',
      });
      const { data } = firstCallArg<{ data: { role: AdminRole } }>(
        prisma.appAdmin.create,
      );
      expect(data.role).toBe(AdminRole.OPERATOR);
    });
  });

  describe('audit trail', () => {
    const ACTOR = {
      id: 'adm_super',
      email: 'super@example.com',
      name: 'Super Admin',
    };
    const targetRow = {
      id: 'adm_1',
      email: 'target@example.com',
      name: 'Target Person',
      role: AdminRole.OPERATOR,
    };

    beforeEach(() => {
      prisma.appAdmin.findUnique.mockResolvedValue(targetRow);
    });

    /** The single audit entry recorded by the call under test. */
    function recordedEntry() {
      expect(audit.record).toHaveBeenCalledTimes(1);
      return (
        audit.record.mock.calls as unknown as [
          Record<string, unknown>,
          unknown,
        ][]
      )[0];
    }

    it('records DEACTIVATE_ADMIN with actor, target and request context', async () => {
      await service.deactivate('adm_1', {
        actor: ACTOR,
        ip: '203.0.113.9',
        userAgent: 'Chrome',
      });

      const [entry, tx] = recordedEntry();
      expect(entry).toMatchObject({
        action: AdminAuditAction.DEACTIVATE_ADMIN,
        actor: ACTOR,
        target: targetRow,
        ip: '203.0.113.9',
        userAgent: 'Chrome',
      });
      // Written through the transaction, so the flag and the record commit
      // together — a deactivation cannot happen unaudited.
      expect(tx).toBeDefined();
    });

    it('records REACTIVATE_ADMIN', async () => {
      await service.reactivate('adm_1', { actor: ACTOR });
      expect(recordedEntry()[0]).toMatchObject({
        action: AdminAuditAction.REACTIVATE_ADMIN,
        target: targetRow,
      });
    });

    it('records CHANGE_ROLE with the before and after roles', async () => {
      await service.changeRole('adm_1', AdminRole.SUPER_ADMIN, {
        actor: ACTOR,
      });

      expect(recordedEntry()[0]).toMatchObject({
        action: AdminAuditAction.CHANGE_ROLE,
        previousRole: AdminRole.OPERATOR,
        newRole: AdminRole.SUPER_ADMIN,
      });
      // A role change must not be carried by a token minted under the old role.
      expect(tokens.revokeAllSessions).toHaveBeenCalledWith('adm_1');
    });

    it('does not audit (or revoke) a role change that changes nothing', async () => {
      await service.changeRole('adm_1', AdminRole.OPERATOR, { actor: ACTOR });
      expect(audit.record).not.toHaveBeenCalled();
      expect(tokens.revokeAllSessions).not.toHaveBeenCalled();
    });

    it("distinguishes resetting someone else's password from changing your own", async () => {
      await service.changePassword('adm_1', 'a-brand-new-password', {
        actor: ACTOR,
      });
      expect(recordedEntry()[0]).toMatchObject({
        action: AdminAuditAction.RESET_PASSWORD,
      });

      audit.record.mockClear();
      await service.changePassword('adm_1', 'another-new-password', {
        actor: { ...ACTOR, id: 'adm_1' },
      });
      expect(recordedEntry()[0]).toMatchObject({
        action: AdminAuditAction.CHANGE_PASSWORD,
      });
    });

    it('records CREATE_ADMIN inside the creating transaction', async () => {
      prisma.appAdmin.create.mockResolvedValue({
        id: 'adm_new',
        email: 'new@example.com',
        name: 'New Person',
        role: AdminRole.MANAGER,
      });

      await service.createAdmin(
        {
          email: 'new@example.com',
          password: PASSWORD,
          name: 'New Person',
          role: AdminRole.MANAGER,
        },
        { actor: ACTOR },
      );

      const [entry, tx] = recordedEntry();
      expect(entry).toMatchObject({
        action: AdminAuditAction.CREATE_ADMIN,
        actor: ACTOR,
        newRole: AdminRole.MANAGER,
      });
      expect(tx).toBeDefined();
    });

    it('records DELETE_ADMIN BEFORE the row is deleted', async () => {
      const order: string[] = [];
      audit.record.mockImplementation(() => {
        order.push('audit');
        return Promise.resolve();
      });
      prisma.appAdmin.delete.mockImplementation(() => {
        order.push('delete');
        return Promise.resolve({});
      });

      await service.deleteAdmin('adm_1', { actor: ACTOR });

      // Order matters: the entry is written first so it exists within the same
      // transaction, and the SET NULL FK leaves it readable via its snapshot.
      expect(order).toEqual(['audit', 'delete']);
      expect(recordedEntry()[0]).toMatchObject({
        action: AdminAuditAction.DELETE_ADMIN,
        target: targetRow,
      });
    });

    it('refuses to audit an action against an admin that does not exist', async () => {
      prisma.appAdmin.findUnique.mockResolvedValue(null);

      await expect(
        service.deactivate('ghost', { actor: ACTOR }),
      ).rejects.toThrow(NotFoundException);
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('deactivate', () => {
    beforeEach(() => {
      prisma.appAdmin.findUnique.mockResolvedValue({
        id: 'adm_1',
        email: 'admin@example.com',
        name: 'Jane Doe',
        role: AdminRole.MANAGER,
      });
    });

    it('clears the flag AND revokes every session', async () => {
      await service.deactivate('adm_1');

      const { data } = firstCallArg<{ data: { isActive: boolean } }>(
        prisma.appAdmin.update,
      );
      expect(data.isActive).toBe(false);
      // The flag alone already blocks the next request (AdminJwtStrategy
      // re-reads it), but the refresh rows must go too, or they would linger
      // until expiry.
      expect(tokens.revokeAllSessions).toHaveBeenCalledWith('adm_1');
    });
  });

  describe('changePassword', () => {
    beforeEach(() => {
      prisma.appAdmin.findUnique.mockResolvedValue({
        id: 'adm_1',
        email: 'admin@example.com',
        name: 'Jane Doe',
        role: AdminRole.MANAGER,
      });
    });

    it('re-hashes and revokes every existing session', async () => {
      await service.changePassword('adm_1', 'a-brand-new-password');

      const { data } = firstCallArg<{ data: { passwordHash: string } }>(
        prisma.appAdmin.update,
      );
      expect(data.passwordHash).toMatch(/^\$argon2id\$/);
      await expect(
        verifyPassword(data.passwordHash, 'a-brand-new-password'),
      ).resolves.toBe(true);
      // A changed password must not leave old tokens alive.
      expect(tokens.revokeAllSessions).toHaveBeenCalledWith('adm_1');
    });
  });
});
