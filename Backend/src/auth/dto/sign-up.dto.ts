import { IsEmail, IsString, MinLength, MaxLength, IsOptional } from 'class-validator';

/** Email + password sign-up (frontend compatibility alias for /v1/auth/register). */
export class SignUpDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;
}
