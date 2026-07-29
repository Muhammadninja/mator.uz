import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PartMainCategory } from '@prisma/client';

/**
 * Body of POST /v1/admin/categories. Creates a PartCategory node.
 *
 * `id` is derived from `slug` (or from `name` when slug is omitted), so a
 * category's slug names it uniquely. `parentId: null`/omitted makes a root.
 *
 * The global ValidationPipe runs with `whitelist: true,
 * forbidNonWhitelisted: true`, so this class IS the accepted-field whitelist.
 */
export class CreateCategoryDto {
  @ApiProperty({ description: 'Display name.', example: 'Turbochargers' })
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @ApiPropertyOptional({
    description:
      'URL slug (also becomes the id). Derived from name when omitted; must be ' +
      'unique.',
    example: 'turbochargers',
  })
  @IsOptional()
  @IsString()
  @MaxLength(96)
  slug?: string;

  @ApiPropertyOptional({
    description: 'Parent category id, or null/omitted for a root category.',
    nullable: true,
    example: 'engine',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(64)
  parentId?: string | null;

  @ApiPropertyOptional({ description: 'Icon key for the buyer grid.', example: 'engine' })
  @IsOptional()
  @IsString()
  @MaxLength(48)
  iconKey?: string;

  @ApiPropertyOptional({ description: 'Accent color (hex).', example: '#4285F4' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  color?: string;

  @ApiPropertyOptional({ description: 'Order among siblings (0-based).', example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional({
    description:
      'PartMainCategory enum this category mirrors (surfaces it in the buyer ' +
      'grid). Omit for a plain sub/custom category.',
    enum: PartMainCategory,
  })
  @IsOptional()
  @IsEnum(PartMainCategory)
  mainCategory?: PartMainCategory;
}
