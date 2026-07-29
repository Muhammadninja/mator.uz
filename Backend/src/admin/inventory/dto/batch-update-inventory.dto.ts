import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * One row of the inventory batch update. Every field but `id` is optional; only
 * the provided fields are written. Numbers are non-negative; cashbackPct is
 * bounded to 0–100.
 */
export class BatchUpdateInventoryItemDto {
  @ApiProperty({ description: 'Part (CatalogPart) id.', example: 'part_abc' })
  @IsString()
  @MaxLength(64)
  id!: string;

  @ApiPropertyOptional({
    description: 'Wholesale/purchase price in UZS (non-negative).',
    example: 120000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  purchasePrice?: number;

  @ApiPropertyOptional({
    description: 'Retail (sell) price in UZS (non-negative).',
    example: 180000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  retailPrice?: number;

  @ApiPropertyOptional({
    description: 'Cashback as a percentage of retail (0–100).',
    example: 5,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  cashbackPct?: number;

  @ApiPropertyOptional({
    description: 'On-hand unit count (non-negative integer).',
    example: 42,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  stock?: number;
}

/**
 * Body of PATCH /v1/admin/inventory/batch-update. Updates many parts' inventory
 * fields in a single transaction. The global ValidationPipe runs with
 * `whitelist: true, forbidNonWhitelisted: true`, so these classes ARE the
 * accepted-field whitelist.
 */
export class BatchUpdateInventoryDto {
  @ApiProperty({ type: [BatchUpdateInventoryItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => BatchUpdateInventoryItemDto)
  items!: BatchUpdateInventoryItemDto[];
}
