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
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/** catalog_parts money columns are Decimal(14, 2). */
const MAX_PRICE_UZS = 999_999_999_999.99;
/** What a part sells for is strictly positive: 0 would give it away. */
const MIN_RETAIL_PRICE_UZS = 0.01;
/** catalog_parts.stock_qty is a 32-bit Int. */
const MAX_STOCK_QTY = 2_147_483_647;
/** Present but null must still reach the validators: the column is NOT NULL. */
const whenPresent = (_: unknown, value: unknown) => value !== undefined;

/**
 * One row of the inventory batch update. Every field but `id` is optional; only
 * the provided fields are written. Numbers are non-negative and bounded by their
 * column; cashbackPct is bounded to 0–100. Only purchasePrice may be null, which
 * clears it (the column means "cost unknown"); the other three are NOT NULL.
 */
export class BatchUpdateInventoryItemDto {
  @ApiProperty({ description: 'Part (CatalogPart) id.', example: 'part_abc' })
  @IsString()
  @MaxLength(64)
  id!: string;

  @ApiPropertyOptional({
    description:
      'Wholesale/purchase price in UZS (non-negative), or null to clear it.',
    example: 120000,
    nullable: true,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_PRICE_UZS)
  purchasePrice?: number | null;

  @ApiPropertyOptional({
    description: 'Retail (sell) price in UZS (greater than zero).',
    example: 180000,
  })
  @ValidateIf(whenPresent)
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(MIN_RETAIL_PRICE_UZS, { message: 'retailPrice must be greater than 0' })
  @Max(MAX_PRICE_UZS)
  retailPrice?: number;

  @ApiPropertyOptional({
    description: 'Cashback as a percentage of retail (0–100).',
    example: 5,
  })
  @ValidateIf(whenPresent)
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  cashbackPct?: number;

  @ApiPropertyOptional({
    description: 'On-hand unit count (non-negative integer).',
    example: 42,
  })
  @ValidateIf(whenPresent)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_STOCK_QTY)
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
