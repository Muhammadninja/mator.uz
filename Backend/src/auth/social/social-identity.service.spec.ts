// INFO-1: the dormant social sign-in never links onto an unproven account and
// never treats an unverified provider email as verified.

import { SocialIdentityService } from './social-identity.service';

function setup(existingUser: Record<string, unknown> | null) {
  const created: any[] = [];
  const prisma: any = {
    authIdentity: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(async (a: any) => a.data),
    },
    appUser: {
      findUnique: jest.fn().mockResolvedValue(existingUser),
      update: jest.fn(),
      create: jest.fn(async (a: any) => {
        created.push(a.data);
        return { id: 'usr_new', ...a.data };
      }),
    },
  };
  prisma.$transaction = (run: (tx: unknown) => unknown) => run(prisma);
  const service = new SocialIdentityService(prisma);
  jest
    .spyOn((service as any).logger, 'log')
    .mockImplementation(() => undefined);
  jest
    .spyOn((service as any).logger, 'warn')
    .mockImplementation(() => undefined);
  return { service, prisma, created };
}

const profile = (over: Record<string, unknown> = {}) => ({
  provider: 'GOOGLE',
  providerUserId: 'g-123',
  email: 'victim@example.com',
  emailVerified: true,
  firstName: 'V',
  lastName: 'U',
  ...over,
});

describe('SocialIdentityService linking', () => {
  it('refuses to link a verified Google email onto an account whose email was never verified', async () => {
    const { service, prisma } = setup({
      id: 'usr_planted',
      email: 'victim@example.com',
      emailVerified: false,
      passwordHash: 'attacker-set',
    });
    await expect(service.resolveUser(profile() as never)).rejects.toMatchObject(
      {
        response: { code: 'EMAIL_ACCOUNT_UNVERIFIED' },
      },
    );
    expect(prisma.authIdentity.create).not.toHaveBeenCalled();
    expect(prisma.appUser.update).not.toHaveBeenCalled();
  });

  it('links onto an account whose own email is verified', async () => {
    const { service, prisma } = setup({
      id: 'usr_real',
      email: 'victim@example.com',
      emailVerified: true,
    });
    await expect(
      service.resolveUser(profile() as never),
    ).resolves.toMatchObject({
      id: 'usr_real',
    });
    expect(prisma.authIdentity.create).toHaveBeenCalledTimes(1);
  });

  it('an unverified provider email creates an isolated account that is NOT marked verified', async () => {
    const { service, created } = setup(null);
    await service.resolveUser(profile({ emailVerified: false }) as never);
    expect(created[0].emailVerified).toBe(false);
  });

  it('an absent provider email gets a placeholder that is never verified', async () => {
    const { service, created } = setup(null);
    await service.resolveUser(
      profile({ email: null, emailVerified: false }) as never,
    );
    expect(created[0].emailVerified).toBe(false);
  });

  it('a verified provider email still creates a verified new account', async () => {
    const { service, created } = setup(null);
    await service.resolveUser(profile() as never);
    expect(created[0].emailVerified).toBe(true);
  });
});
