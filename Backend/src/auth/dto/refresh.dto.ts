import { IsString, IsOptional } from 'class-validator';

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
}
