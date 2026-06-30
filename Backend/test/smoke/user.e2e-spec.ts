import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { UserService } from '../../src/user/user.service';
import { createPrismaMock, buildAppUser, PrismaMock } from '../utils/harness';

describe('User API smoke', () => {
  let prisma: PrismaMock;
  let svc: UserService;

  beforeEach(() => {
    prisma = createPrismaMock();
    svc = new UserService(prisma);
  });

  it('getMe returns the profile shape without secrets', async () => {
    prisma.appUser.findUnique.mockResolvedValue(
      buildAppUser({ id: 'usr_1', email: 'a@b.uz', language: 'UZ', passwordHash: 'secret' }),
    );

    const res: any = await svc.getMe('usr_1');

    expect(res.id).toBe('usr_1');
    expect(res.email).toBe('a@b.uz');
    expect(res.language).toBe('UZ');
    expect(res.role).toBe('user');
    expect((res as any).passwordHash).toBeUndefined();
  });

  it('getMe throws 404 for an unknown user', async () => {
    prisma.appUser.findUnique.mockResolvedValue(null);
    await expect(svc.getMe('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('updateMe applies only provided fields and normalizes language to the enum', async () => {
    prisma.appUser.update.mockResolvedValue(
      buildAppUser({ id: 'usr_1', displayName: 'New Name', language: 'EN' }),
    );

    const res: any = await svc.updateMe('usr_1', { display_name: 'New Name', language: 'en' } as any);

    expect(res.display_name).toBe('New Name');
    expect(res.language).toBe('EN');
    const data = prisma.appUser.update.mock.calls[0][0].data;
    expect(data).toEqual({ displayName: 'New Name', language: 'EN' });
    // fields not in the DTO must not be written
    expect(data.firstName).toBeUndefined();
    expect(data.avatarUrl).toBeUndefined();
  });

  it('updateMe maps Prisma P2025 to a 404', async () => {
    const known = new Prisma.PrismaClientKnownRequestError('not found', {
      code: 'P2025',
      clientVersion: 'x',
    });
    prisma.appUser.update.mockRejectedValue(known);
    await expect(svc.updateMe('usr_x', { display_name: 'X' } as any)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
