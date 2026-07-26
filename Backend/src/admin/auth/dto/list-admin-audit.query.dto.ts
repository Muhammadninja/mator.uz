import { ApiPropertyOptional } from '@nestjs/swagger';
import { AdminAuditAction } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** Filters for GET /v1/auth/admin/audit. */
export class ListAdminAuditQueryDto {
  @ApiPropertyOptional({
    description: 'Only entries about this administrator.',
  })
  @IsOptional()
  @IsString()
  targetAdminId?: string;

  @ApiPropertyOptional({
    description: 'Only entries performed by this administrator.',
  })
  @IsOptional()
  @IsString()
  actorId?: string;

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
