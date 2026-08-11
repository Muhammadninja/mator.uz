import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
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

  // ── Фискальные данные ─────────────────────────────────────────────────────
  // Optional on create (a category may be configured later) but never PARTIAL:
  // the service rejects a body that sets one of these without the others it
  // requires, so a half-configured category cannot be stored.
  @ApiPropertyOptional({
    description: 'MXIK / ИКПУ — exactly 17 digits.',
    example: '08708005011000000',
  })
  @IsOptional()
  @IsString()
  @Matches(MXIK_PATTERN, { message: 'mxik must be exactly 17 digits' })
  mxik?: string;

  @ApiPropertyOptional({
    description: 'Tasnif package code for a single item ("Штука").',
    example: '1417722',
  })
  @IsOptional()
  @IsString()
  @Matches(PACKAGE_CODE_PATTERN, {
    message: 'packageCodeSingle must be 1–20 digits',
  })
  packageCodeSingle?: string;

  @ApiPropertyOptional({
    description:
      'Tasnif package code for a set ("Комплект / набор"). Optional — its ' +
      'presence is what makes the seller bot ask how the item is sold.',
    example: '1417723',
  })
  @IsOptional()
  @IsString()
  @Matches(PACKAGE_CODE_PATTERN, {
    message: 'packageCodeSet must be 1–20 digits',
  })
  packageCodeSet?: string;
}
