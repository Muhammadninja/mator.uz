import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { NodeCategory } from '@prisma/client';

/** GET /v1/admin/fitment-studio/unmapped-parts?vehicleModelId&nodeCategory&search&page&limit */
export class GetUnmappedPartsQueryDto {
  @IsString()
  vehicleModelId!: string;

  /** Filter the catalogue to categories valid for this node category. */
  @IsOptional()
  @IsEnum(NodeCategory)
  nodeCategory?: NodeCategory;

  /** Case-insensitive match on name + oem. */
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
