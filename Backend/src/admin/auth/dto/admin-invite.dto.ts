import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AdminRole } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Emails are stored lowercase; normalize at the boundary. */
const normalizeEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/**
 * Password rules for administrator accounts — the SAME policy the management
 * console's CreateAdminDto uses (min 12, max 72), so a password set via an invite
 * is held to the identical bar. 72 also matches the login cap, so a password
 * created here is always submittable at login.
 */
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 72;

/** Body of POST /v1/auth/admin/invites — a SUPER_ADMIN invites one email. */
export class CreateAdminInviteDto {
  @ApiProperty({ example: 'ops@example.com', maxLength: 255 })
  @IsEmail()
  @MaxLength(255)
  @Transform(normalizeEmail)
  email: string;

  @ApiPropertyOptional({
    enum: AdminRole,
    default: AdminRole.OPERATOR,
    description:
      'Role the invited administrator will hold. Defaults to the least-privileged role.',
  })
  @IsOptional()
  @IsEnum(AdminRole)
  role?: AdminRole;
}

/** Body of POST /v1/auth/admin/invites/:token/accept — the invitee sets up. */
export class AcceptAdminInviteDto {
  @ApiProperty({ example: 'Jane Doe', maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  name: string;

  @ApiProperty({ minLength: PASSWORD_MIN, maxLength: PASSWORD_MAX })
  @IsString()
  @MinLength(PASSWORD_MIN)
  @MaxLength(PASSWORD_MAX)
  password: string;
}

/**
 * Public preview of an invite (GET /v1/auth/admin/invites/:token). Carries only
 * the invited email and role — never the token, never anything that would let
 * the page act on the invite without re-presenting the raw token on accept.
 */
export class AdminInvitePreviewDto {
  @ApiProperty({ example: 'ops@example.com' })
  email: string;

  @ApiProperty({ enum: AdminRole, example: AdminRole.OPERATOR })
  role: AdminRole;
}
