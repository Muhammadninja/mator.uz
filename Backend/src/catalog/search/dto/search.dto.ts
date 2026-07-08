import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsInt, IsObject } from 'class-validator';
import { Type } from 'class-transformer';

export class SearchDto {
  @IsOptional()
  @IsString()
  query?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number;

  // Opaque cursor from a previous response; `null` on the first page.
  @ApiPropertyOptional({ type: String, nullable: true, description: 'Opaque pagination cursor from the previous response.' })
  @IsOptional()
  @IsString()
  pageToken?: string | null;

  // Free-form facet map (e.g. { brand_ids: ['brand_gates'], condition: 'new' }).
  @ApiPropertyOptional({ type: 'object', additionalProperties: true, description: 'Free-form facet filters.' })
  @IsOptional()
  @IsObject()
  filters?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  sortBy?: string;

  @IsOptional()
  @IsString()
  requestId?: string;

  @IsOptional()
  @IsString()
  locale?: string;

  // Selected vehicle used to bias results (make/model/year, etc.).
  @ApiPropertyOptional({ type: 'object', additionalProperties: true, description: 'Vehicle context used to bias results.' })
  @IsOptional()
  @IsObject()
  vehicleContext?: Record<string, unknown>;
}
