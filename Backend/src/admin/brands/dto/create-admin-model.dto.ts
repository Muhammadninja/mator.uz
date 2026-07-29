import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body of POST /v1/admin/brands/:brandId/models. `name` is required; `id` may
 * pin the slug (unique within the make), otherwise the service derives it. The
 * global ValidationPipe (`forbidNonWhitelisted: true`) rejects other fields.
 */
export class CreateAdminModelDto {
  @ApiProperty({ description: 'Model name.', example: 'Camry' })
  @IsString()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({
    description: 'Explicit slug id. Derived from the name when omitted.',
    example: 'camry',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  id?: string;

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
