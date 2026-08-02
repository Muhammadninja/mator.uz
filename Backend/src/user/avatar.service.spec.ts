// Unit tests for AvatarService. Prisma, CloudinaryService and the HTTP
// reachability probe are mocked — no DB, no real upload, no network. These
// guard: type validation (415), size validation (413), missing-file rejection,
// reuse of the existing Cloudinary store, the superset response shape
// ({ url, avatar_url, avatarUrl }) that keeps every documented client working,
// and the persistence rules that fix the "disappearing avatar" bug —
// public_id is stored, a dead URL is NEVER persisted (502), and replacing an
// avatar destroys the OLD asset rather than the new one.

import {
  BadGatewayException,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import axios from 'axios';
import { AvatarService, MAX_AVATAR_BYTES } from './avatar.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const URL =
  'https://res.cloudinary.com/mator/image/upload/v1/mator/avatars/a.png';
const PUBLIC_ID = 'mator/avatars/a';

function build(
  existing: { avatarPublicId: string | null } | null = { avatarPublicId: null },
) {
  const prisma = {
    appUser: {
      findUnique: jest.fn().mockResolvedValue(existing),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const cloudinary = {
    uploadBuffer: jest
      .fn()
      .mockResolvedValue({ url: URL, publicId: PUBLIC_ID }),
    deleteAssets: jest.fn().mockResolvedValue(undefined),
  };
  const service = new AvatarService(prisma as never, cloudinary as never);
  return { service, prisma, cloudinary };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: the uploaded asset serves (HTTP 200), i.e. the healthy path.
  mockedAxios.head.mockResolvedValue({ status: 200 } as never);
});

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
    // The public_id is persisted alongside the URL — without it nothing could
    // name the asset later, which is what made avatars undeletable.
    expect(prisma.appUser.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { avatarUrl: URL, avatarPublicId: PUBLIC_ID },
    });
    // Superset: url (RN client), avatar_url (task text), avatarUrl (spec doc).
    expect(res).toEqual({ url: URL, avatar_url: URL, avatarUrl: URL });
  });

  it('verifies the asset is reachable BEFORE persisting the URL', async () => {
    const { service, prisma } = build();

    await service.upload('u1', file());

    expect(mockedAxios.head).toHaveBeenCalledWith(URL, expect.any(Object));
    expect(prisma.appUser.update).toHaveBeenCalled();
  });

  it('returns 502 and persists NOTHING when the uploaded asset is unreachable', async () => {
    const { service, prisma, cloudinary } = build();
    mockedAxios.head.mockResolvedValue({ status: 404 } as never);

    await expect(service.upload('u1', file())).rejects.toBeInstanceOf(
      BadGatewayException,
    );

    // The contract: never store a known-dead avatar URL.
    expect(prisma.appUser.update).not.toHaveBeenCalled();
    // The unusable upload is cleaned up rather than left as an orphan.
    expect(cloudinary.deleteAssets).toHaveBeenCalledWith([PUBLIC_ID]);
  });

  it('returns 502 when the reachability probe throws (transport failure)', async () => {
    const { service, prisma } = build();
    mockedAxios.head.mockRejectedValue(new Error('ECONNRESET'));

    await expect(service.upload('u1', file())).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    expect(prisma.appUser.update).not.toHaveBeenCalled();
  });

  it('replacing an avatar destroys the PREVIOUS asset, never the new one', async () => {
    const { service, cloudinary } = build({
      avatarPublicId: 'mator/avatars/old',
    });

    await service.upload('u1', file());

    expect(cloudinary.deleteAssets).toHaveBeenCalledWith(['mator/avatars/old']);
    expect(cloudinary.deleteAssets).not.toHaveBeenCalledWith([PUBLIC_ID]);
  });

  it('does not delete anything when the re-upload returns the SAME public id', async () => {
    // A byte-identical re-upload can reuse the id; deleting it would destroy the
    // avatar that was just persisted.
    const { service, cloudinary } = build({ avatarPublicId: PUBLIC_ID });

    await service.upload('u1', file());

    expect(cloudinary.deleteAssets).not.toHaveBeenCalled();
  });

  it('does not delete anything when the user had no previous avatar', async () => {
    const { service, cloudinary } = build({ avatarPublicId: null });

    await service.upload('u1', file());

    expect(cloudinary.deleteAssets).not.toHaveBeenCalled();
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
