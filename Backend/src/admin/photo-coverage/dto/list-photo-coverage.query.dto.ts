import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Photo filters the coverage list accepts. */
export const PHOTO_COVERAGE_FILTERS = ['all', 'with', 'without'] as const;
export type PhotoCoverageFilter = (typeof PHOTO_COVERAGE_FILTERS)[number];

/**
 * Query params for GET /v1/admin/photo-coverage/parts. Offset pagination, the
 * photo filter, a category (its whole subtree is included) and three separate
 * searches: by name, by OEM / part number, by Driver's Village 1C code. Every
 * search is a case-insensitive "contains".
 */
export class ListPhotoCoverageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @IsIn(PHOTO_COVERAGE_FILTERS, {
    message: 'photo must be one of: all, with, without',
  })
  photo?: PhotoCoverageFilter;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  oem?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  code1c?: string;
}
