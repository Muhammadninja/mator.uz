import { IsString, IsOptional, IsInt, IsObject, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class TopFeaturedDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;

  @IsOptional()
  @IsString()
  sortBy?: string;

  @IsOptional()
  @IsString()
  search?: string | null;

  @IsOptional()
  @IsObject()
  filters?: { model?: string; brand?: string; color?: string; condition?: string };
}
