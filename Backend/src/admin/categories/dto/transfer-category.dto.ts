import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/** Query of GET /v1/admin/categories/:id/transfer/preview. */
export class TransferPreviewQueryDto {
  @ApiProperty({ description: 'Category the contents would move to.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  targetCategoryId!: string;
}

/**
 * Body of POST /v1/admin/categories/:id/transfer. The `expected*` counts are what
 * the operator saw in the preview: if the category filled up meanwhile, the
 * transfer refuses rather than moving things nobody looked at.
 */
export class TransferCategoryDto {
  @ApiProperty({ description: 'Category the contents move to.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  targetCategoryId!: string;

  @ApiProperty({ description: 'Why, for the audit trail.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: 'reason is required' })
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({ description: 'Catalog parts the preview reported.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedParts?: number;

  @ApiPropertyOptional({ description: 'Listings the preview reported.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedListings?: number;

  @ApiPropertyOptional({ description: 'Live drafts the preview reported.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedDrafts?: number;
}
