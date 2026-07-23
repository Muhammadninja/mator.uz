import type { AppUser } from '@prisma/client';
import type { presentAddress } from '../addresses/address.presenter';

type PresentedAddress = ReturnType<typeof presentAddress>;

/**
 * Map an AppUser row to the buyer-app profile shape (snake_case, no secrets).
 * `address` is the user's default address (or null when they have none); it is
 * sourced from the shared Address table via AddressesService, not stored on the
 * user, so there is a single source of truth for addresses.
 */
export function presentMe(
  user: AppUser,
  address: PresentedAddress | null = null,
) {
  return {
    id: user.id,
    email: user.email,
    email_verified: user.emailVerified,
    phone_e164: user.phoneE164,
    phone_verified: user.phoneVerified,
    display_name: user.displayName,
    first_name: user.firstName,
    last_name: user.lastName,
    avatar_url: user.avatarUrl,
    thumbnail_url: user.thumbnailUrl,
    role: user.role.toLowerCase(),
    language: user.language,
    myid_status: user.myIdStatus.toLowerCase(),
    transaction_limit_uzs: Number(user.transactionLimitUzs),
    address,
    created_at: user.createdAt.toISOString(),
    updated_at: user.updatedAt.toISOString(),
  };
}
