import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
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
 * Body of PATCH /v1/admin/categories/:id. Partial update of a PartCategory.
 * Every field is optional; only provided fields are written. Changing parentId
 * reuses the move cycle-guard.
 *
 * The global ValidationPipe runs with `whitelist: true,
 * forbidNonWhitelisted: true`, so this class IS the accepted-field whitelist.
 */
export class UpdateCategoryDto {
  @ApiPropertyOptional({ description: 'Display name.', example: 'Turbochargers' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name?: string;

  @ApiPropertyOptional({ description: 'URL slug (unique).', example: 'turbochargers' })
  @IsOptional()
  @IsString()
  @MaxLength(96)
  slug?: string;

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

  @ApiPropertyOptional({
    description: 'New parent id, or null to promote to root. Cycle-guarded.',
    nullable: true,
    example: 'engine',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(64)
  parentId?: string | null;

  @ApiPropertyOptional({ description: 'Order among siblings (0-based).', example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional({ description: 'Active/visible in the buyer grid.', example: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    description: 'PartMainCategory enum this category mirrors (or clears it).',
    enum: PartMainCategory,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsEnum(PartMainCategory)
  mainCategory?: PartMainCategory | null;
}
