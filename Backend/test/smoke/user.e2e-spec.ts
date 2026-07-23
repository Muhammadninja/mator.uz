import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { UserService } from '../../src/user/user.service';
import { AddressesService } from '../../src/addresses/addresses.service';
import { createPrismaMock, buildAppUser, PrismaMock } from '../utils/harness';

describe('User API smoke', () => {
  let prisma: PrismaMock;
  let addresses: AddressesService;
  let svc: UserService;

  beforeEach(() => {
    prisma = createPrismaMock();
    // Real AddressesService over the same Prisma double; getDefault resolves to
    // null (address.findFirst is an unstubbed jest.fn) unless a test sets it.
    addresses = new AddressesService(prisma);
    svc = new UserService(prisma, addresses);
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

  it('getMe includes the default address (or null)', async () => {
    prisma.appUser.findUnique.mockResolvedValue(buildAppUser({ id: 'usr_1' }));
    prisma.address.findFirst.mockResolvedValue(null);
    const res: any = await svc.getMe('usr_1');
    expect(res).toHaveProperty('address', null);
  });

  it('updateMe upserts the default address when an inline address is sent', async () => {
    prisma.appUser.update.mockResolvedValue(buildAppUser({ id: 'usr_1' }));
    // No existing default -> upsertDefault creates one.
    prisma.address.findFirst.mockResolvedValue(null);
    prisma.address.create.mockResolvedValue({
      id: 'addr_1',
      userId: 'usr_1',
      label: 'Home',
      regionCode: 'UZ-TK',
      district: null,
      street: null,
      fullText: 'Amir Temur 12, Toshkent',
      lat: null,
      lng: null,
      isDefault: true,
      createdAt: new Date('2026-07-23T00:00:00Z'),
      updatedAt: new Date('2026-07-23T00:00:00Z'),
    });

    const res: any = await svc.updateMe('usr_1', {
      address: { full_text: 'Amir Temur 12, Toshkent', label: 'Home', region_code: 'UZ-TK' },
    } as any);

    expect(prisma.address.create).toHaveBeenCalled();
    expect(res.address).toEqual(
      expect.objectContaining({ full_text: 'Amir Temur 12, Toshkent', is_default: true }),
    );
  });

  it('updateMe does NOT touch addresses when no address field is present', async () => {
    prisma.appUser.update.mockResolvedValue(buildAppUser({ id: 'usr_1' }));
    prisma.address.findFirst.mockResolvedValue(null); // getDefault -> null
    const upsertSpy = jest.spyOn(addresses, 'upsertDefault');

    await svc.updateMe('usr_1', { display_name: 'Only Name' } as any);

    // A profile-only PATCH must not create/update any address row.
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(prisma.address.create).not.toHaveBeenCalled();
    expect(prisma.address.update).not.toHaveBeenCalled();
    expect(prisma.address.updateMany).not.toHaveBeenCalled();
  });
});
