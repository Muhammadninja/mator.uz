import {
  BadGatewayException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import axios from 'axios';
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

/** Bound on the post-upload reachability probe (ms) — a slow CDN must not hang
 *  the request; the probe failing open is handled explicitly below. */
const REACHABILITY_TIMEOUT_MS = 5000;

/**
 * Avatar upload for an authenticated user. Reuses the existing
 * {@link CloudinaryService} image store — no new upload implementation — and
 * persists the returned URL on the user's `avatarUrl`. Validation (type + size)
 * lives here so the same rules apply regardless of how the multipart request was
 * parsed, and so the errors map to the exact statuses the frontend spec expects
 * (415 unsupported type, 413 too large).
 *
 * ── Avatar persistence (the "disappearing avatar" fix) ──────────────────────
 * Two things guard the stored URL now:
 *
 *  1. The Cloudinary `public_id` is PERSISTED alongside the URL. Previously only
 *     the URL was kept, so nothing in the system could name the asset — which
 *     both made deletion impossible and meant a replaced avatar leaked its
 *     predecessor forever. Storing the id is also what lets account deletion
 *     destroy exactly the right asset instead of parsing it out of the URL.
 *
 *  2. The URL is VERIFIED reachable before it is written to the database. A dead
 *     URL is never persisted; the contract is "never store a known-dead avatar
 *     URL", so an unreachable asset is a 502 and the profile keeps the avatar it
 *     already had.
 *
 * Replacing an avatar destroys the PREVIOUS asset only — read before the update
 * and deleted after it commits — so the newly uploaded image can never be the
 * one cleaned up.
 */
@Injectable()
export class AvatarService {
  private readonly logger = new Logger(AvatarService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  /**
   * True when the freshly uploaded asset actually serves. A lightweight HEAD
   * against the secure URL catches the case this method exists for: an upload
   * that reported success but whose asset does not deliver.
   *
   * Deliberately strict — any non-2xx, or a transport error, counts as
   * unreachable, because persisting a URL we could not confirm is exactly the
   * failure being fixed.
   */
  private async isReachable(url: string): Promise<boolean> {
    try {
      const res = await axios.head(url, {
        timeout: REACHABILITY_TIMEOUT_MS,
        // Resolve on any status so a 404 is inspected here rather than thrown.
        validateStatus: () => true,
      });
      return res.status >= 200 && res.status < 300;
    } catch (err) {
      this.logger.warn(
        `Avatar reachability probe failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

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

    // Never persist a URL we have not confirmed serves. On failure the just-
    // uploaded asset is removed (it is unusable and would otherwise be an
    // orphan) and the caller gets a 502 — the previous avatar, if any, is left
    // untouched because nothing has been written yet.
    if (!(await this.isReachable(uploaded.url))) {
      await this.cloudinary.deleteAssets([uploaded.publicId]);
      throw new BadGatewayException(
        'The uploaded image could not be verified. Please try again.',
      );
    }

    // Read the asset being REPLACED before overwriting the row, so the old one
    // can be cleaned up afterwards. Read-then-update, never the reverse: after
    // the update the previous id is gone, and deleting before the update would
    // destroy the live avatar if the write then failed.
    let previousPublicId: string | null = null;
    try {
      const before = await this.prisma.appUser.findUnique({
        where: { id: userId },
        select: { avatarPublicId: true },
      });
      if (!before) throw new NotFoundException('User not found');
      previousPublicId = before.avatarPublicId;

      await this.prisma.appUser.update({
        where: { id: userId },
        data: { avatarUrl: uploaded.url, avatarPublicId: uploaded.publicId },
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

    // Best-effort cleanup of the REPLACED asset, after the new one is safely
    // persisted. Guarded against deleting the asset just uploaded (a re-upload
    // of a byte-identical image can return the same public_id), which is the
    // exact way this kind of cleanup goes wrong.
    if (previousPublicId && previousPublicId !== uploaded.publicId) {
      await this.cloudinary.deleteAssets([previousPublicId]);
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
