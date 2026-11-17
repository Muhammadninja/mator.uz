import { IsString, Matches } from 'class-validator';

/**
 * The gallery version the operator's screen was showing (from
 * GET /v1/admin/photo-coverage/parts/:id/photos). Every change carries it, in
 * the multipart body for an upload and in the query for a delete. A gallery
 * that changed since is refused with 409 PHOTOS_CHANGED instead of losing the
 * other change or deleting a photo the operator never saw.
 */
export class PartPhotosVersionDto {
  @IsString()
  @Matches(/^[0-9a-f]{32}$/, { message: 'version must be a gallery version' })
  version!: string;
}
