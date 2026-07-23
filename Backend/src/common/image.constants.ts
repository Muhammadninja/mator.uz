/**
 * Shared image-upload limits and Cloudinary folder names. Centralised here so
 * every image endpoint enforces the same rules and there is a single place to
 * change a limit or reorganise storage — avoiding folder sprawl
 * (products/avatars/profile/users/…) and per-endpoint magic numbers.
 */

/** Max avatar image size: 5 MB (matches the frontend profile spec §3). */
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

/** Accepted avatar image MIME types (matches the frontend profile spec §3). */
export const ALLOWED_IMAGE_MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

/**
 * Cloudinary folders under the single `mator/` namespace (the store's existing
 * convention — CloudinaryService defaults product uploads to `mator/products`).
 */
export const CloudinaryFolder = {
  PRODUCTS: 'mator/products',
  AVATARS: 'mator/avatars',
} as const;
