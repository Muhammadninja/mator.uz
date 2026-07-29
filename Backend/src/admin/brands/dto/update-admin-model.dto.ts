import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body of PATCH /v1/admin/models/:id — the editable model fields. `id`,
 * `makeId` and `sortOrder` are immutable/system-owned and absent. The global
 * ValidationPipe (`forbidNonWhitelisted: true`) rejects any other field.
 */
export class UpdateAdminModelDto {
  @ApiPropertyOptional({ description: 'Model name.', example: 'Camry' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({
    description: 'First production year.',
    example: 2018,
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  yearFrom?: number | null;

  @ApiPropertyOptional({
    description: 'Last production year.',
    example: 2024,
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  yearTo?: number | null;

  @ApiPropertyOptional({
    description: 'Body type.',
    example: 'sedan',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  bodyType?: string | null;
}
