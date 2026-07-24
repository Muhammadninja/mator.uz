export interface JwtPayload {
  sub: string;
  email: string | null;
  role: string;
  // Session version the token was signed with. Checked against
  // AppUser.tokenVersion on every authenticated request; a mismatch means the
  // token was revoked (see TokenService.revokeAllSessions).
  tokenVersion: number;
  // Per-token unique id (UUID v4). Stamped at signing time; on logout the token
  // is blacklisted in Redis under RedisKeys.jwtBlacklist(jti) so that single
  // access token stops validating immediately, without touching any other
  // session (see JwtStrategy.validate / TokenService.blacklistAccessToken).
  jti?: string;
  // Standard JWT expiry (seconds since epoch). Set by the signer; used to size
  // the blacklist entry's TTL so Redis evicts it exactly when the token dies.
  exp?: number;
}
