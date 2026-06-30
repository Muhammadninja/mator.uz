import { IsEmail, IsString, MinLength, MaxLength } from 'class-validator';

/** Email + password sign-in (frontend compatibility alias for /v1/auth/login). */
export class SignInDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password: string;
}
