import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';

export class AppleLoginDto {
  /** The Apple identity token (JWT) returned by Sign in with Apple. */
  @IsString()
  @IsNotEmpty()
  identityToken: string;

  // Apple only sends the user's name on the FIRST authorization, in the
  // response body (never in the token). Forward it so we can store it once.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;
}
