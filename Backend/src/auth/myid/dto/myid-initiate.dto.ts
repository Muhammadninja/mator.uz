import { IsString, IsOptional, IsArray, IsUUID } from 'class-validator';

export class MyIdInitiateDto {
  // Authoritative user comes from the JWT; this is accepted but not trusted.
  @IsOptional()
  @IsUUID()
  user_id?: string;

  @IsString()
  redirect_uri: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  scopes?: string[];

  @IsOptional()
  @IsString()
  ui_locale?: string;

  // Optional client-side PKCE challenge; if absent, the backend generates one.
  @IsOptional()
  @IsString()
  code_challenge?: string;
}
