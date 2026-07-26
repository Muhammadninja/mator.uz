import { AdminRole } from '@prisma/client';

/**
 * Claims carried by an admin access token. The `type` discriminator is the
 * explicit, readable marker that this is an admin credential; the hard
 * guarantee that it cannot be accepted by a user guard comes from the separate
 * secret/algorithm/audience (see AdminAuthConfig), with `type` checked on top.
 */
export interface AdminJwtPayload {
  sub: string;
  role: AdminRole;
  type: 'admin';
  // Session version the token was signed with. Checked against
  // AppAdmin.tokenVersion on every authenticated request; a mismatch means the
  // token was revoked (deactivation, password change, refresh reuse).
  tokenVersion: number;
  // Per-token unique id. Reserved for single-token blacklisting; logout today
  // invalidates the refresh token and bumps nothing, so this is informational.
  jti?: string;
  // Standard JWT expiry (seconds since epoch), set by the signer.
  exp?: number;
}
