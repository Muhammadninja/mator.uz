import {
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import {
  ALLOWED_IMAGE_MIME,
  CloudinaryFolder,
  MAX_AVATAR_BYTES,
} from '../common/image.constants';

// Re-exported for the controller (multer limit) and tests, so the single
// source of truth remains common/image.constants.ts.
export { MAX_AVATAR_BYTES } from '../common/image.constants';

/**
 * Avatar upload for an authenticated user. Reuses the existing
 * {@link CloudinaryService} image store — no new upload implementation — and
 * persists the returned URL on the user's `avatarUrl`. Validation (type + size)
 * lives here so the same rules apply regardless of how the multipart request was
 * parsed, and so the errors map to the exact statuses the frontend spec expects
 * (415 unsupported type, 413 too large).
 */
@Injectable()
export class AvatarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  async upload(
    userId: string,
    file?: { buffer: Buffer; mimetype: string; size: number },
  ) {
    if (!file || !file.buffer?.length) {
      throw new UnsupportedMediaTypeException('An image file is required.');
    }
    if (!(ALLOWED_IMAGE_MIME as readonly string[]).includes(file.mimetype)) {
      throw new UnsupportedMediaTypeException(
        'Unsupported image type. Allowed: JPEG, PNG, WebP.',
      );
    }
    if (file.size > MAX_AVATAR_BYTES) {
      throw new PayloadTooLargeException('Image exceeds the 5 MB size limit.');
    }

    const uploaded = await this.cloudinary.uploadBuffer(
      file.buffer,
      CloudinaryFolder.AVATARS,
    );

    try {
      await this.prisma.appUser.update({
        where: { id: userId },
        data: { avatarUrl: uploaded.url },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new NotFoundException('User not found');
      }
      throw err;
    }

    // Return a superset of the documented response shapes so every existing
    // client keeps working with no change: the runtime RN client reads `url`,
    // the profile spec doc documents `avatarUrl`, and the task text uses
    // `avatar_url`.
    return {
      url: uploaded.url,
      avatar_url: uploaded.url,
      avatarUrl: uploaded.url,
    };
  }
}
