import { IsString, IsOptional } from 'class-validator';

export class MyIdCallbackDto {
  @IsString()
  session_id: string;

  @IsString()
  code: string;

  @IsString()
  state: string;

  // Client-held PKCE verifier (public-client flow). Optional when the backend
  // generated the PKCE pair itself.
  @IsOptional()
  @IsString()
  code_verifier?: string;
}
