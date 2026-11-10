// LOW-ADM-006: the invitation lifecycle. Prisma is mocked; the row locks are
// represented by what the locked SELECTs return, in call order: the invite
// first, then its issuer.

import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminAuditAction, AdminRole } from '@prisma/client';
import { createHash } from 'crypto';
import { AdminInviteService } from './admin-invite.service';

const TOKEN = 'raw-invite-token';
const HASH = createHash('sha256').update(TOKEN).digest('hex');
const future = () => new Date(Date.now() + 3_600_000);

const inviteRow = (over: Record<string, unknown> = {}) => ({
  id: 'inv_1',
  email: 'new@example.com',
  role: AdminRole.OPERATOR,
  invited_by_id: 'adm_super',
  expires_at: future(),
  accepted_at: null,
  ...over,
});
const inviterRow = (over: Record<string, unknown> = {}) => ({
  id: 'adm_super',
  email: 'super@example.com',
  name: 'Super',
  role: AdminRole.SUPER_ADMIN,
  is_active: true,
  ...over,
});

function setup() {
  const prisma = {
    adminInvite: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'inv_1',
        email: 'new@example.com',
        role: AdminRole.OPERATOR,
        acceptedAt: null,
        expiresAt: future(),
        invitedBy: {
          id: 'adm_super',
          email: 'super@example.com',
          name: 'Super',
          role: AdminRole.SUPER_ADMIN,
          isActive: true,
        },
      }),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    appAdmin: { findUnique: jest.fn().mockResolvedValue(null) },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((run: (tx: unknown) => unknown) =>
    Promise.resolve(run(prisma)),
  );
  const adminAuth = {
    createAdmin: jest.fn().mockResolvedValue({
      id: 'adm_new',
      email: 'new@example.com',
      name: 'New',
      role: AdminRole.OPERATOR,
    }),
  };
  const tokens = {
    issueSession: jest.fn().mockResolvedValue({
      accessToken: 'a',
      refreshToken: 'r',
      expiresIn: 900,
    }),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const mail = { sendAdminInvite: jest.fn() };
  const service = new AdminInviteService(
    prisma as never,
    adminAuth as never,
    tokens as never,
    audit as never,
    mail as never,
  );
  const locked = (invite: unknown, inviter?: unknown) => {
    prisma.$queryRaw
      .mockResolvedValueOnce(invite ? [invite] : [])
      .mockResolvedValueOnce(inviter ? [inviter] : []);
  };
  return { prisma, adminAuth, tokens, audit, service, locked };
}

const accept = (service: AdminInviteService) =>
  service.accept(TOKEN, { name: 'New', password: 'a-long-password-1' });

describe('AdminInviteService.accept', () => {
  it('an invite from an active SUPER_ADMIN creates the account in the same transaction and signs in', async () => {
    const { prisma, adminAuth, tokens, audit, service, locked } = setup();
    locked(inviteRow(), inviterRow());

    await expect(accept(service)).resolves.toMatchObject({ accessToken: 'a' });

    // The invite and its issuer are read under row locks, by token hash.
    const [inviteSql, inviterSql] = prisma.$queryRaw.mock.calls.map((c) =>
      (c as unknown as [TemplateStringsArray])[0].join('?'),
    );
    expect(inviteSql).toMatch(
      /FROM admin_invites WHERE token_hash = \?[\s\S]*FOR UPDATE/,
    );
    expect((prisma.$queryRaw.mock.calls[0] as unknown[])[1]).toBe(HASH);
    expect(inviterSql).toMatch(/FROM app_admins[\s\S]*FOR SHARE/);

    expect(prisma.adminInvite.update).toHaveBeenCalledWith({
      where: { id: 'inv_1' },
      data: { acceptedAt: expect.any(Date) as Date },
    });
    // Created through the caller's transaction, attributed to the issuer.
    expect(adminAuth.createAdmin).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'new@example.com',
        role: AdminRole.OPERATOR,
      }),
      { actor: { id: 'adm_super', email: 'super@example.com', name: 'Super' } },
      prisma,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: AdminAuditAction.ACCEPT_INVITE }),
      prisma,
    );
    expect(tokens.issueSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['deactivated', inviterRow({ is_active: false })],
    ['demoted', inviterRow({ role: AdminRole.MANAGER })],
    ['deleted', undefined],
  ])('is refused and voided when its issuer was %s', async (_what, inviter) => {
    const { prisma, adminAuth, tokens, service, locked } = setup();
    locked(inviteRow(inviter ? {} : { invited_by_id: null }), inviter);

    await expect(accept(service)).rejects.toThrow(NotFoundException);

    expect(adminAuth.createAdmin).not.toHaveBeenCalled();
    expect(tokens.issueSession).not.toHaveBeenCalled();
    expect(prisma.adminInvite.delete).toHaveBeenCalledWith({
      where: { id: 'inv_1' },
    });
  });

  it.each([
    ['consumed', inviteRow({ accepted_at: new Date() })],
    ['expired', inviteRow({ expires_at: new Date(Date.now() - 1000) })],
    ['revoked (row gone)', undefined],
  ])(
    'a %s invite is not found, whatever the earlier unlocked read said',
    async (_what, invite) => {
      const { adminAuth, service, locked } = setup();
      locked(invite, inviterRow());

      await expect(accept(service)).rejects.toThrow('Invite not found');
      expect(adminAuth.createAdmin).not.toHaveBeenCalled();
    },
  );

  it('is one-time: of two accepts of one link, the second finds it used', async () => {
    const { prisma, adminAuth, service } = setup();
    // The row lock serialises them; the second reads the committed claim.
    prisma.$queryRaw
      .mockResolvedValueOnce([inviteRow()])
      .mockResolvedValueOnce([inviterRow()])
      .mockResolvedValueOnce([inviteRow({ accepted_at: new Date() })]);

    await accept(service);
    await expect(accept(service)).rejects.toThrow('Invite not found');
    expect(adminAuth.createAdmin).toHaveBeenCalledTimes(1);
  });

  it('a failed account creation propagates, leaving the claim to roll back with the transaction', async () => {
    const { adminAuth, tokens, service, locked } = setup();
    locked(inviteRow(), inviterRow());
    adminAuth.createAdmin.mockRejectedValue(new Error('db blip'));

    await expect(accept(service)).rejects.toThrow('db blip');
    expect(tokens.issueSession).not.toHaveBeenCalled();
  });

  it('burns the invite and reports a conflict when the email already has an account', async () => {
    const { prisma, adminAuth, service, locked } = setup();
    locked(inviteRow(), inviterRow());
    prisma.appAdmin.findUnique.mockResolvedValue({ id: 'adm_existing' });

    await expect(accept(service)).rejects.toThrow(ConflictException);
    expect(adminAuth.createAdmin).not.toHaveBeenCalled();
    expect(prisma.adminInvite.update).toHaveBeenCalledTimes(1);
  });
});

describe('AdminInviteService preview / list / revoke', () => {
  it('preview hides an invite whose issuer may no longer invite', async () => {
    const { prisma, service } = setup();
    prisma.adminInvite.findFirst.mockResolvedValue({
      email: 'new@example.com',
      role: AdminRole.OPERATOR,
      acceptedAt: null,
      expiresAt: future(),
      invitedBy: { role: AdminRole.SUPER_ADMIN, isActive: false },
    });
    await expect(service.preview(TOKEN)).rejects.toThrow('Invite not found');
  });

  it('lists only pending invites and never selects token material', async () => {
    const { prisma, service } = setup();
    await service.listPending();

    const arg = (
      prisma.adminInvite.findMany.mock.calls[0] as unknown as [
        { where: Record<string, unknown>; select: Record<string, unknown> },
      ]
    )[0];
    expect(arg.where).toEqual({
      acceptedAt: null,
      expiresAt: { gt: expect.any(Date) as Date },
    });
    expect(arg.select.tokenHash).toBeUndefined();
    expect(Object.keys(arg.select).sort()).toEqual([
      'createdAt',
      'email',
      'expiresAt',
      'id',
      'invitedBy',
      'role',
    ]);
  });

  it('revoke deletes the pending invite, so its link can never be reused', async () => {
    const { prisma, service } = setup();
    await service.revoke('inv_1', {});
    expect(prisma.adminInvite.deleteMany).toHaveBeenCalledWith({
      where: { id: 'inv_1', acceptedAt: null },
    });
  });

  it('revoke of an unknown or already accepted invite is a 404', async () => {
    const { prisma, service } = setup();
    prisma.adminInvite.deleteMany.mockResolvedValue({ count: 0 });
    await expect(service.revoke('inv_x', {})).rejects.toThrow(
      NotFoundException,
    );
  });
});
