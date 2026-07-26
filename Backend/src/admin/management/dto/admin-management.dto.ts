import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AdminAuditAction, AdminRole } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** Emails are stored lowercase; normalize at the boundary. */
const normalizeEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/**
 * Password rules for administrator accounts. Stricter than the 8-character
 * login minimum: a login DTO must accept whatever legacy passwords exist, but a
 * password being SET now can be held to a higher bar. 72 matches the login cap
 * so a password created here is always submittable.
 */
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 72;

export class CreateAdminDto {
  @ApiProperty({ example: 'ops@example.com', maxLength: 255 })
  @IsEmail()
  @MaxLength(255)
  @Transform(normalizeEmail)
  email: string;

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

  @ApiPropertyOptional({
    enum: AdminRole,
    default: AdminRole.OPERATOR,
    description: 'Defaults to the least-privileged role.',
  })
  @IsOptional()
  @IsEnum(AdminRole)
  role?: AdminRole;
}

/** Profile fields only. Role, password and activation have dedicated routes. */
export class UpdateAdminDto {
  @ApiPropertyOptional({ example: 'Jane Doe', maxLength: 120 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  name?: string;

  @ApiPropertyOptional({ example: 'ops@example.com', maxLength: 255 })
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  @Transform(normalizeEmail)
  email?: string;
}

export class ChangeAdminRoleDto {
  @ApiProperty({ enum: AdminRole })
  @IsEnum(AdminRole)
  role: AdminRole;
}

export class ChangeAdminPasswordDto {
  @ApiProperty({ minLength: PASSWORD_MIN, maxLength: PASSWORD_MAX })
  @IsString()
  @MinLength(PASSWORD_MIN)
  @MaxLength(PASSWORD_MAX)
  password: string;
}

export class ListAdminsQueryDto {
  @ApiPropertyOptional({ description: 'Match against name or email.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  search?: string;

  @ApiPropertyOptional({ enum: AdminRole })
  @IsOptional()
  @IsEnum(AdminRole)
  role?: AdminRole;

  @ApiPropertyOptional({ description: 'Filter by activation state.' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  take?: number;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;
}

export class ListAuditQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() targetAdminId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() actorId?: string;

  @ApiPropertyOptional({ enum: AdminAuditAction })
  @IsOptional()
  @IsEnum(AdminAuditAction)
  action?: AdminAuditAction;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  take?: number;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;
}

/** An administrator as returned by the management API. Never a hash. */
export class AdminResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() email: string;
  @ApiProperty() name: string;
  @ApiProperty({ enum: AdminRole }) role: AdminRole;
  @ApiProperty() isActive: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastLoginAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt: Date;
}
