// Unit tests for the /v1/admins management layer. Prisma and AdminAuthService
// are mocked — no DB.
//
// The service is deliberately thin (every mutation delegates to the audited
// AdminAuthService), so these tests concentrate on what it uniquely owns:
//
//   • LOCKOUT SAFETY — the console must not be brickable from inside it. Losing
//     the last active SUPER_ADMIN, or an admin destroying their own access
//     mid-session, leaves no way back short of shell access.
//   • delegation to the audited path, so nothing bypasses the audit trail;
//   • never selecting or returning a password hash.

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AdminRole } from '@prisma/client';
import { AdminManagementService } from './admin-management.service';

function makePrismaMock() {
  const appAdmin = {
    findUnique: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(1),
    update: jest.fn().mockResolvedValue({}),
  };
  return { appAdmin };
}

function makeAuthMock() {
  return {
    createAdmin: jest.fn().mockResolvedValue({ id: 'adm_new' }),
    changeRole: jest.fn().mockResolvedValue(undefined),
    changePassword: jest.fn().mockResolvedValue(undefined),
    reactivate: jest.fn().mockResolvedValue(undefined),
    deactivate: jest.fn().mockResolvedValue(undefined),
    deleteAdmin: jest.fn().mockResolvedValue(undefined),
  };
}

function makeTokensMock() {
  return {
    listSessions: jest.fn().mockResolvedValue([]),
    revokeSession: jest.fn().mockResolvedValue(true),
  };
}

const ACTOR = {
  id: 'adm_super',
  email: 'super@example.com',
  name: 'Super Admin',
};
const AUDIT = { actor: ACTOR, ip: '203.0.113.1', userAgent: 'Chrome' };

function adminRow(over: Record<string, unknown> = {}) {
  return {
    id: 'adm_1',
    email: 'target@example.com',
    name: 'Target Person',
    role: AdminRole.OPERATOR,
    isActive: true,
    lastLoginAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  };
}

describe('AdminManagementService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let auth: ReturnType<typeof makeAuthMock>;
  let tokens: ReturnType<typeof makeTokensMock>;
  let service: AdminManagementService;

  beforeEach(() => {
    prisma = makePrismaMock();
    auth = makeAuthMock();
    tokens = makeTokensMock();
    service = new AdminManagementService(
      prisma as never,
      auth as never,
      tokens as never,
    );
  });

  describe('lockout safety', () => {
    it('refuses to delete the last active SUPER_ADMIN', async () => {
      prisma.appAdmin.findUnique.mockResolvedValue(
        adminRow({ role: AdminRole.SUPER_ADMIN }),
      );
      prisma.appAdmin.count.mockResolvedValue(0); // none left besides this one

      await expect(service.remove('adm_1', AUDIT)).rejects.toThrow(
        /last active SUPER_ADMIN/,
      );
      expect(auth.deleteAdmin).not.toHaveBeenCalled();
    });

    it('refuses to demote the last active SUPER_ADMIN', async () => {
      prisma.appAdmin.findUnique.mockResolvedValue(
        adminRow({ role: AdminRole.SUPER_ADMIN }),
      );
      prisma.appAdmin.count.mockResolvedValue(0);

      await expect(
        service.changeRole('adm_1', AdminRole.MANAGER, AUDIT),
      ).rejects.toThrow(/last active SUPER_ADMIN/);
      expect(auth.changeRole).not.toHaveBeenCalled();
    });

    it('refuses to deactivate the last active SUPER_ADMIN', async () => {
      prisma.appAdmin.findUnique.mockResolvedValue(
        adminRow({ role: AdminRole.SUPER_ADMIN }),
      );
      prisma.appAdmin.count.mockResolvedValue(0);

      await expect(service.deactivate('adm_1', AUDIT)).rejects.toThrow(
        /last active SUPER_ADMIN/,
      );
      expect(auth.deactivate).not.toHaveBeenCalled();
    });

    it('counts only ACTIVE super admins as a safety net', async () => {
      prisma.appAdmin.findUnique.mockResolvedValue(
        adminRow({ role: AdminRole.SUPER_ADMIN }),
      );
      prisma.appAdmin.count.mockResolvedValue(1);
      await service.remove('adm_1', AUDIT);

      // A deactivated super admin cannot log in, so leaving one behind is the
      // same as leaving none — the count must exclude them.
      const arg = (
        prisma.appAdmin.count.mock.calls as unknown as {
          where: Record<string, unknown>;
        }[][]
      )[0][0];
      expect(arg.where).toMatchObject({
        role: AdminRole.SUPER_ADMIN,
        isActive: true,
        id: { not: 'adm_1' },
      });
    });

    it('allows removing a SUPER_ADMIN while another active one remains', async () => {
      prisma.appAdmin.findUnique.mockResolvedValue(
        adminRow({ role: AdminRole.SUPER_ADMIN }),
      );
      prisma.appAdmin.count.mockResolvedValue(2);

      await expect(service.remove('adm_1', AUDIT)).resolves.toBeUndefined();
      expect(auth.deleteAdmin).toHaveBeenCalledWith('adm_1', AUDIT);
    });
  });

  describe('self-targeting guards', () => {
    beforeEach(() => {
      prisma.appAdmin.findUnique.mockResolvedValue(
        adminRow({ id: ACTOR.id, role: AdminRole.SUPER_ADMIN }),
      );
      prisma.appAdmin.count.mockResolvedValue(5);
    });

    it('refuses to delete your own account', async () => {
      await expect(service.remove(ACTOR.id, AUDIT)).rejects.toThrow(
        /your own account/,
      );
      expect(auth.deleteAdmin).not.toHaveBeenCalled();
    });

    it('refuses to deactivate your own account', async () => {
      // Would invalidate the caller's session in the middle of the request.
      await expect(service.deactivate(ACTOR.id, AUDIT)).rejects.toThrow(
        /your own account/,
      );
      expect(auth.deactivate).not.toHaveBeenCalled();
    });

    it('refuses to demote yourself', async () => {
      // Demotion removes the very permission needed to undo it.
      await expect(
        service.changeRole(ACTOR.id, AdminRole.OPERATOR, AUDIT),
      ).rejects.toThrow(/your own role/);
      expect(auth.changeRole).not.toHaveBeenCalled();
    });

    it('still allows resetting your own password', async () => {
      // Not destructive: it is the normal self-service rotation.
      await expect(
        service.changePassword(ACTOR.id, 'a-new-strong-password', AUDIT),
      ).resolves.toBeUndefined();
      expect(auth.changePassword).toHaveBeenCalled();
    });
  });

  describe('delegation to the audited layer', () => {
    beforeEach(() => {
      prisma.appAdmin.findUnique.mockResolvedValue(adminRow());
      prisma.appAdmin.count.mockResolvedValue(3);
    });

    it.each([
      [
        'changeRole',
        () => service.changeRole('adm_1', AdminRole.MANAGER, AUDIT),
        'changeRole',
      ],
      [
        'changePassword',
        () => service.changePassword('adm_1', 'new-password-here', AUDIT),
        'changePassword',
      ],
      ['deactivate', () => service.deactivate('adm_1', AUDIT), 'deactivate'],
      ['remove', () => service.remove('adm_1', AUDIT), 'deleteAdmin'],
    ])(
      '%s goes through AdminAuthService with the audit context',
      async (_l, call, method) => {
        await call();
        const mock = auth[method as keyof typeof auth];
        expect(mock).toHaveBeenCalled();
        // The audit context (actor + provenance) must reach the audited path, or
        // the entry would be anonymous.
        expect(JSON.stringify(mock.mock.calls[0])).toContain('adm_super');
      },
    );

    it('reactivate is idempotent and does not re-audit an active account', async () => {
      prisma.appAdmin.findUnique.mockResolvedValue(
        adminRow({ isActive: true }),
      );
      await service.activate('adm_1', AUDIT);
      expect(auth.reactivate).not.toHaveBeenCalled();
    });

    it('reactivate audits when the account really was inactive', async () => {
      prisma.appAdmin.findUnique.mockResolvedValue(
        adminRow({ isActive: false }),
      );
      await service.activate('adm_1', AUDIT);
      expect(auth.reactivate).toHaveBeenCalledWith('adm_1', AUDIT);
    });
  });

  describe('reads', () => {
    it('never selects the password hash', async () => {
      prisma.appAdmin.findUnique.mockResolvedValue(adminRow());
      await service.getOne('adm_1');

      const arg = (
        prisma.appAdmin.findUnique.mock.calls as unknown as {
          select: Record<string, boolean>;
        }[][]
      )[0][0];
      expect(arg.select.passwordHash).toBeUndefined();
      expect(arg.select.tokenVersion).toBeUndefined();
    });

    it('404s an unknown administrator', async () => {
      prisma.appAdmin.findUnique.mockResolvedValue(null);
      await expect(service.getOne('ghost')).rejects.toThrow(NotFoundException);
    });

    it('clamps the page size', async () => {
      await service.list({ take: 5000 });
      const arg = (
        prisma.appAdmin.findMany.mock.calls as unknown as { take: number }[][]
      )[0][0];
      expect(arg.take).toBe(200);
    });

    it('searches name and email case-insensitively', async () => {
      await service.list({ search: 'Jane' });
      const arg = (
        prisma.appAdmin.findMany.mock.calls as unknown as {
          where: { OR?: unknown[] };
        }[][]
      )[0][0];
      expect(arg.where.OR).toHaveLength(2);
      expect(JSON.stringify(arg.where.OR)).toContain('insensitive');
    });
  });

  describe('create', () => {
    it('rejects a duplicate email with 409', async () => {
      prisma.appAdmin.findUnique.mockResolvedValue({ id: 'existing' });
      await expect(
        service.create(
          { email: 'taken@example.com', name: 'X', password: 'password-1234' },
          AUDIT,
        ),
      ).rejects.toThrow(ConflictException);
      expect(auth.createAdmin).not.toHaveBeenCalled();
    });

    it('creates through the audited path when the email is free', async () => {
      prisma.appAdmin.findUnique
        .mockResolvedValueOnce(null) // duplicate check
        .mockResolvedValueOnce(adminRow({ id: 'adm_new' })); // getOne after create

      await service.create(
        { email: 'new@example.com', name: 'New', password: 'password-1234' },
        AUDIT,
      );
      expect(auth.createAdmin).toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('rejects an email already used by another administrator', async () => {
      prisma.appAdmin.findUnique
        .mockResolvedValueOnce(adminRow()) // getOne
        .mockResolvedValueOnce({ id: 'someone_else' }); // clash

      await expect(
        service.update('adm_1', { email: 'taken@example.com' }, AUDIT),
      ).rejects.toThrow(ConflictException);
    });

    it('allows an administrator to keep their own email', async () => {
      prisma.appAdmin.findUnique
        .mockResolvedValueOnce(adminRow())
        .mockResolvedValueOnce({ id: 'adm_1' }) // the same admin
        .mockResolvedValueOnce(adminRow());

      await expect(
        service.update('adm_1', { email: 'target@example.com' }, AUDIT),
      ).resolves.toBeDefined();
    });

    it('rejects an empty patch', async () => {
      prisma.appAdmin.findUnique.mockResolvedValue(adminRow());
      await expect(service.update('adm_1', {}, AUDIT)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('sessions of another administrator', () => {
    it('404s before touching sessions of an unknown admin', async () => {
      prisma.appAdmin.findUnique.mockResolvedValue(null);
      await expect(service.listSessions('ghost')).rejects.toThrow(
        NotFoundException,
      );
      expect(tokens.listSessions).not.toHaveBeenCalled();
    });

    it('revokes a single session scoped to that administrator', async () => {
      prisma.appAdmin.findUnique.mockResolvedValue(adminRow());
      await service.revokeSession('adm_1', 42);
      expect(tokens.revokeSession).toHaveBeenCalledWith('adm_1', 42);
    });

    it('404s a session that is not theirs', async () => {
      prisma.appAdmin.findUnique.mockResolvedValue(adminRow());
      tokens.revokeSession.mockResolvedValue(false);
      await expect(service.revokeSession('adm_1', 999)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
