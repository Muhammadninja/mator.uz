import { IsIn, IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export const CATEGORY_SCOPES = ['main', 'vehicle'] as const;

/** Query for GET /v1/categories. */
export class ListCategoriesQueryDto {
  @ApiPropertyOptional({
    enum: CATEGORY_SCOPES,
    description: "Which hierarchy level to return. 'main' = home-page grid (default), 'vehicle' = the make/model grouping.",
  })
  @IsOptional()
  @IsIn(CATEGORY_SCOPES)
  scope?: (typeof CATEGORY_SCOPES)[number];

  @ApiPropertyOptional({ description: 'Scope per-category counts to parts that fit this garage vehicle.' })
  @IsOptional()
  @IsString()
  vehicle_id?: string;
}
