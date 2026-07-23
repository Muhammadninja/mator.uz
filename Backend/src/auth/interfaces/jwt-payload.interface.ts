export interface JwtPayload {
  sub: string;
  email: string | null;
  role: string;
  // Session version the token was signed with. Checked against
  // AppUser.tokenVersion on every authenticated request; a mismatch means the
  // token was revoked (see TokenService.revokeAllSessions).
  tokenVersion: number;
}
