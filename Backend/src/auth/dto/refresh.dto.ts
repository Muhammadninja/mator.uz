import { IsString, IsOptional, MaxLength } from 'class-validator';

/**
 * Refresh-token body accepting BOTH key styles so the consolidated
 * /v1/auth/refresh serves the legacy email client (`refreshToken`, camelCase)
 * and the frontend contract (`refresh_token`, snake_case). The controller
 * resolves whichever was supplied and rejects when neither is present.
 */
export class RefreshDto {
  @IsOptional()
  @IsString()
  refreshToken?: string;

  @IsOptional()
  @IsString()
  refresh_token?: string;

  /**
   * Logout only: the install being signed out, so its push tokens are released
   * even when the session was not bound to a device at sign-in. Ignored by the
   * refresh endpoints.
   */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  install_id?: string;
}
