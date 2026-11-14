import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const PART_ID = /^[A-Za-z0-9_-]+$/;

export class FavoritePartDto {
  @IsString()
  @MaxLength(64)
  @Matches(PART_ID)
  partId!: string;
}

export class FavoriteImportDto {
  @IsString()
  @MaxLength(128)
  @Matches(/\S/)
  importId!: string;

  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  @Matches(PART_ID, { each: true })
  partIds!: string[];
}

export class FavoriteListDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  pageToken?: string;
}
