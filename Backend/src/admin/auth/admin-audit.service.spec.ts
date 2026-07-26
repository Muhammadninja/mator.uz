// Unit tests for the administrator audit trail. Prisma is mocked — no DB.
//
// An audit log is only worth having if it cannot be quietly bypassed or
// rewritten, so these tests pin the properties that give it evidential value:
//
//   • the entry is written through the CALLER'S transaction when one is passed,
//     so a change and its record commit or fail together;
//   • actor and target identities are SNAPSHOTS, so an entry stays readable
//     after either account is renamed or deleted;
//   • no credential material (password, hash, token) is ever written;
//   • actions with no signed-in actor (the CLI bootstrap) are labelled rather
//     than left anonymous.

import { AdminAuditAction, AdminRole } from '@prisma/client';
import { AdminAuditService } from './admin-audit.service';

function makePrismaMock() {
  const adminAudit = {
    create: jest.fn().mockResolvedValue({}),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
  };
  return { adminAudit };
}

/** First argument of a jest mock's first call, typed by the caller. */
function firstCallArg<T>(fn: jest.Mock): T {
  return (fn.mock.calls as unknown as T[][])[0][0];
}

const ACTOR = {
  id: 'adm_super',
  email: 'super@example.com',
  name: 'Super Admin',
};
const TARGET = {
  id: 'adm_target',
  email: 'target@example.com',
  name: 'Target Person',
};

describe('AdminAuditService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: AdminAuditService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new AdminAuditService(prisma as never);
  });

  describe('record', () => {
    it('snapshots both identities, not just their ids', async () => {
      await service.record({
        action: AdminAuditAction.DEACTIVATE_ADMIN,
        actor: ACTOR,
        target: TARGET,
      });

      const { data } = firstCallArg<{ data: Record<string, unknown> }>(
        prisma.adminAudit.create,
      );
      // Ids alone would render as "unknown" once an account is deleted; the
      // snapshot is what keeps the entry meaningful.
      expect(data).toMatchObject({
        action: AdminAuditAction.DEACTIVATE_ADMIN,
        actorId: 'adm_super',
        actorEmail: 'super@example.com',
        actorName: 'Super Admin',
        targetAdminId: 'adm_target',
        targetEmail: 'target@example.com',
        targetName: 'Target Person',
      });
    });

    it('writes through the transaction the caller supplies', async () => {
      const tx = { adminAudit: { create: jest.fn().mockResolvedValue({}) } };

      await service.record(
        {
          action: AdminAuditAction.CHANGE_ROLE,
          actor: ACTOR,
          target: TARGET,
          previousRole: AdminRole.OPERATOR,
          newRole: AdminRole.MANAGER,
        },
        tx as never,
      );

      // The whole point: the audit row lives or dies with the change it records.
      expect(tx.adminAudit.create).toHaveBeenCalledTimes(1);
      expect(prisma.adminAudit.create).not.toHaveBeenCalled();
    });

    it('records the before/after roles for a privilege change', async () => {
      await service.record({
        action: AdminAuditAction.CHANGE_ROLE,
        actor: ACTOR,
        target: TARGET,
        previousRole: AdminRole.OPERATOR,
        newRole: AdminRole.SUPER_ADMIN,
      });

      const { data } = firstCallArg<{
        data: { previousRole: AdminRole; newRole: AdminRole };
      }>(prisma.adminAudit.create);
      expect(data.previousRole).toBe(AdminRole.OPERATOR);
      expect(data.newRole).toBe(AdminRole.SUPER_ADMIN);
    });

    it('labels an action that has no signed-in actor', async () => {
      await service.record({
        action: AdminAuditAction.CREATE_ADMIN,
        actorLabel: 'cli:admin:create',
        target: TARGET,
      });

      const { data } = firstCallArg<{
        data: { actorId: string | null; actorLabel: string };
      }>(prisma.adminAudit.create);
      // Null actor is fine — anonymous-looking null actor with no explanation
      // is not.
      expect(data.actorId).toBeNull();
      expect(data.actorLabel).toBe('cli:admin:create');
    });

    it('truncates untrusted request metadata to the column widths', async () => {
      await service.record({
        action: AdminAuditAction.DEACTIVATE_ADMIN,
        actor: ACTOR,
        target: TARGET,
        ip: '203.0.113.9',
        userAgent: 'U'.repeat(900),
      });

      const { data } = firstCallArg<{
        data: { ip: string; userAgent: string };
      }>(prisma.adminAudit.create);
      expect(data.ip).toBe('203.0.113.9');
      expect(data.userAgent).toHaveLength(400);
    });

    it('records THAT a password changed, never any part of the credential', async () => {
      await service.record({
        action: AdminAuditAction.CHANGE_PASSWORD,
        actor: ACTOR,
        target: TARGET,
      });

      const { data } = firstCallArg<{ data: Record<string, unknown> }>(
        prisma.adminAudit.create,
      );
      // The action name is the ONLY place the word "password" may appear. The
      // written columns are a fixed whitelist, so no credential field can be
      // added to an audit entry by accident.
      expect(Object.keys(data).sort()).toEqual([
        'action',
        'actorEmail',
        'actorId',
        'actorLabel',
        'actorName',
        'ip',
        'newRole',
        'previousRole',
        'targetAdminId',
        'targetEmail',
        'targetName',
        'userAgent',
      ]);
      const values = Object.entries(data)
        .filter(([key]) => key !== 'action')
        .map(([, value]) => String(value))
        .join(' ')
        .toLowerCase();
      for (const forbidden of [
        'password',
        'hash',
        'token',
        'secret',
        '$argon2',
        '$2b$',
      ]) {
        expect(values).not.toContain(forbidden);
      }
    });
  });

  describe('list', () => {
    it('returns newest first', async () => {
      await service.list({});
      const arg = firstCallArg<{ orderBy: { createdAt: string } }>(
        prisma.adminAudit.findMany,
      );
      expect(arg.orderBy).toEqual({ createdAt: 'desc' });
    });

    it('filters by target, actor and action', async () => {
      await service.list({
        targetAdminId: 'adm_target',
        actorId: 'adm_super',
        action: AdminAuditAction.DELETE_ADMIN,
      });

      const arg = firstCallArg<{ where: Record<string, unknown> }>(
        prisma.adminAudit.findMany,
      );
      expect(arg.where).toEqual({
        targetAdminId: 'adm_target',
        actorId: 'adm_super',
        action: AdminAuditAction.DELETE_ADMIN,
      });
    });

    it('omits absent filters instead of matching on undefined', async () => {
      await service.list({ targetAdminId: 'adm_target' });
      const arg = firstCallArg<{ where: Record<string, unknown> }>(
        prisma.adminAudit.findMany,
      );
      expect(arg.where).toEqual({ targetAdminId: 'adm_target' });
    });

    it.each([
      [undefined, 50],
      [10, 10],
      [500, 200], // clamped: an unbounded page size is a DoS vector
      [0, 1],
      [-5, 1],
    ])('clamps take=%p to %p', async (take, expected) => {
      await service.list({ take });
      const arg = firstCallArg<{ take: number }>(prisma.adminAudit.findMany);
      expect(arg.take).toBe(expected);
    });

    it('never returns a negative offset', async () => {
      await service.list({ skip: -20 });
      const arg = firstCallArg<{ skip: number }>(prisma.adminAudit.findMany);
      expect(arg.skip).toBe(0);
    });
  });
});
