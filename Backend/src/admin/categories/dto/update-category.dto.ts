import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PartMainCategory } from '@prisma/client';
import {
  MXIK_PATTERN,
  PACKAGE_CODE_PATTERN,
} from '../../../common/fiscal.util';

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

  // ── Фискальные данные ─────────────────────────────────────────────────────
  // `null` clears a field. The SERVICE checks the resulting combination, not
  // this class: validity here is per-field (shape), while "a configured category
  // has both an MXIK and a single package code" is a property of the row AFTER
  // the patch is applied, and only the service can see that.
  @ApiPropertyOptional({
    description: 'MXIK / ИКПУ — exactly 17 digits, or null to clear.',
    nullable: true,
    example: '08708005011000000',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Matches(MXIK_PATTERN, { message: 'mxik must be exactly 17 digits' })
  mxik?: string | null;

  @ApiPropertyOptional({
    description:
      'Tasnif package code for a single item ("Штука"), or null to clear.',
    nullable: true,
    example: '1417722',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Matches(PACKAGE_CODE_PATTERN, {
    message: 'packageCodeSingle must be 1–20 digits',
  })
  packageCodeSingle?: string | null;

  @ApiPropertyOptional({
    description:
      'Tasnif package code for a set ("Комплект / набор"), or null to clear. ' +
      'Its presence is what makes the seller bot ask how the item is sold.',
    nullable: true,
    example: '1417723',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Matches(PACKAGE_CODE_PATTERN, {
    message: 'packageCodeSet must be 1–20 digits',
  })
  packageCodeSet?: string | null;
}
