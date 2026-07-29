import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body of PATCH /v1/admin/brands/:id — the editable brand fields. `id`,
 * `sortOrder` and the audit timestamps are deliberately absent: the slug is
 * immutable and ordering/timestamps are system-owned. The global ValidationPipe
 * (`forbidNonWhitelisted: true`) rejects any other field with 400.
 */
export class UpdateAdminBrandDto {
  @ApiPropertyOptional({ description: 'Brand (make) name.', example: 'Toyota' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ description: 'Logo image URL.', nullable: true })
  @IsOptional()
  @IsString()
  logoUrl?: string | null;

  @ApiPropertyOptional({
    description: 'Country of origin.',
    example: 'Japan',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  country?: string | null;

  @ApiPropertyOptional({
    description: 'Whether the brand is active (visible in the catalog).',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
