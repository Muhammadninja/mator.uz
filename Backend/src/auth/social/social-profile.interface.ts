import { AuthProvider } from '@prisma/client';

/**
 * Normalized identity extracted from a verified Google/Apple token.
 * Every provider verifier maps its raw claims into this shape so the
 * account-linking logic stays provider-agnostic.
 */
export interface SocialProfile {
  provider: AuthProvider;
  /** The provider's stable, immutable subject identifier (the `sub` claim). */
  providerUserId: string;
  /** May be absent (Apple "Hide My Email" can still send a relay address). */
  email: string | null;
  /** Only trust email-based account linking when the provider asserts this. */
  emailVerified: boolean;
  firstName: string | null;
  lastName: string | null;
}
