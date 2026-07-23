// Unit tests for AvatarService. Prisma and CloudinaryService are mocked — no DB,
// no real upload. These guard: type validation (415), size validation (413),
// missing-file rejection, reuse of the existing Cloudinary store, persistence of
// the returned URL, and the superset response shape ({ url, avatar_url,
// avatarUrl }) that keeps every documented client working unchanged.

import {
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AvatarService, MAX_AVATAR_BYTES } from './avatar.service';

const URL =
  'https://res.cloudinary.com/mator/image/upload/v1/mator/avatars/a.png';

function build() {
  const prisma = { appUser: { update: jest.fn().mockResolvedValue({}) } };
  const cloudinary = {
    uploadBuffer: jest
      .fn()
      .mockResolvedValue({ url: URL, publicId: 'mator/avatars/a' }),
  };
  const service = new AvatarService(prisma as never, cloudinary as never);
  return { service, prisma, cloudinary };
}

function file(
  over: Partial<{ buffer: Buffer; mimetype: string; size: number }> = {},
) {
  return {
    buffer: over.buffer ?? Buffer.from('img'),
    mimetype: over.mimetype ?? 'image/jpeg',
    size: over.size ?? 1024,
  };
}

describe('AvatarService', () => {
  it('uploads a valid JPEG, persists the URL and returns the superset shape', async () => {
    const { service, prisma, cloudinary } = build();

    const res = await service.upload('u1', file());

    expect(cloudinary.uploadBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      'mator/avatars',
    );
    expect(prisma.appUser.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { avatarUrl: URL },
    });
    // Superset: url (RN client), avatar_url (task text), avatarUrl (spec doc).
    expect(res).toEqual({ url: URL, avatar_url: URL, avatarUrl: URL });
  });

  it.each(['image/png', 'image/webp'])('accepts %s', async (mimetype) => {
    const { service, cloudinary } = build();
    await service.upload('u1', file({ mimetype }));
    expect(cloudinary.uploadBuffer).toHaveBeenCalled();
  });

  it('rejects an unsupported type with 415 and never uploads', async () => {
    const { service, cloudinary } = build();
    await expect(
      service.upload('u1', file({ mimetype: 'application/pdf' })),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    expect(cloudinary.uploadBuffer).not.toHaveBeenCalled();
  });

  it('rejects a file over the 5 MB limit with 413', async () => {
    const { service, cloudinary } = build();
    await expect(
      service.upload('u1', file({ size: MAX_AVATAR_BYTES + 1 })),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(cloudinary.uploadBuffer).not.toHaveBeenCalled();
  });

  it('rejects a missing file with 415', async () => {
    const { service } = build();
    await expect(service.upload('u1', undefined)).rejects.toBeInstanceOf(
      UnsupportedMediaTypeException,
    );
  });

  it('maps a missing user (P2025) to 404', async () => {
    const { service, prisma } = build();
    prisma.appUser.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('nf', {
        code: 'P2025',
        clientVersion: 'x',
      }),
    );
    await expect(service.upload('ghost', file())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
