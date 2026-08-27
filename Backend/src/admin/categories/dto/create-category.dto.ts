import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PartMainCategory } from '@prisma/client';
import { IsUzbekLatin } from '../../../common/is-uzbek-latin.validator';
import {
  MXIK_PATTERN,
  PACKAGE_CODE_PATTERN,
} from '../../../common/fiscal.util';

/**
 * Body of POST /v1/admin/categories. Creates a PartCategory node.
 *
 * `id` is derived from `slug` (or from `nameEn` when slug is omitted — the
 * English name is the only one guaranteed to slugify to something non-empty),
 * so a category's slug names it uniquely. `parentId: null`/omitted makes a
 * root.
 *
 * The global ValidationPipe runs with `whitelist: true,
 * forbidNonWhitelisted: true`, so this class IS the accepted-field whitelist.
 */
export class CreateCategoryDto {
  // ── Localized names (ALL THREE REQUIRED) ──────────────────────────────────
  // A category is displayed to Russian, Uzbek and English speakers alike, so it
  // is not creatable until it has a name for each of them. `@Transform` trims
  // first so that "   " is rejected by `@IsNotEmpty` — a whitespace-only name
  // would otherwise pass validation and render as a blank button in the bot.
  @ApiProperty({
    description: 'Display name in Russian. Required, non-blank.',
    example: 'Турбокомпрессоры',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: 'nameRu is required and cannot be empty' })
  @MaxLength(160)
  nameRu!: string;

  // Script-checked, unlike its RU/EN siblings: "Uzbek (Latin)" is a real
  // constraint, and the mistake that actually happens is a Russian name pasted
  // into this field. `@IsUzbekLatin` rejects that (see uzbek-latin.util for the
  // alphabet); presence is still `@IsNotEmpty`'s job, so a blank and a
  // wrong-script value report under their own constraint keys.
  @ApiProperty({
    description:
      'Display name in Uzbek (LATIN script). Required, non-blank. Cyrillic ' +
      'and any other non-Latin script are rejected; digits, hyphens and the ' +
      "O'/G' apostrophe forms are allowed.",
    example: 'Turbokompressorlar',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: 'nameUz is required and cannot be empty' })
  @IsUzbekLatin({
    message: 'nameUz must contain only Uzbek Latin characters',
  })
  @MaxLength(160)
  nameUz!: string;

  @ApiProperty({
    description:
      'Display name in English. Required, non-blank. Also the source the ' +
      'slug/id is derived from when no explicit slug is given.',
    example: 'Turbochargers',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: 'nameEn is required and cannot be empty' })
  @MaxLength(160)
  nameEn!: string;

  @ApiPropertyOptional({
    description:
      'Internal canonical label (logs, ordering, legacy consumers). Defaults ' +
      'to nameEn when omitted — the console does not need to send it.',
    example: 'Turbochargers',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name?: string;

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
