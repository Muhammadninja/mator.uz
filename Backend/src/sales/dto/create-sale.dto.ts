import { SaleDiscountType, SaleScopeType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  Validate,
} from 'class-validator';
import { SaleWindowConstraint } from './sale-window.validator';
import { SaleDiscountValueConstraint } from './sale-discount-value.validator';

/** Upper bound on how many subjects one sale may target in a single call. */
export const MAX_SALE_TARGETS = 500;

/**
 * Create a sale. The two cross-field rules that a per-property decorator cannot
 * express live in dedicated constraints:
 *
 *   • SaleDiscountValueConstraint — a PERCENT sale's value must be <= 100,
 *     which depends on `discountType`. `@IsPositive` already covers "> 0" for
 *     both types, so a FIXED value of 0 is rejected here as well: a sale that
 *     discounts nothing is a configuration mistake, not a valid campaign.
 *   • SaleWindowConstraint — endAt must not precede startAt.
 *
 * Both run through the global ValidationPipe, so a bad body is a 400 before any
 * service code executes.
 */
export class CreateSaleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsEnum(SaleDiscountType, {
    message: 'discountType must be PERCENT or FIXED',
  })
  discountType!: SaleDiscountType;

  /**
   * Percent: 0 < value <= 100. Fixed: value > 0, in UZS.
   * `maxDecimalPlaces: 2` matches the Decimal(14,2) column, so a value that
   * would be silently rounded by the database is rejected instead.
   */
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive({ message: 'discountValue must be greater than 0' })
  @Validate(SaleDiscountValueConstraint)
  discountValue!: number;

  @IsOptional()
  @IsEnum(SaleScopeType, {
    message:
      'scopeType must be one of: ALL_PRODUCTS, PRODUCTS, CATEGORIES, DEALERS',
  })
  scopeType?: SaleScopeType;

  /**
   * The ids this sale targets — products, categories or dealers, per
   * `scopeType`. Required for every scope except ALL_PRODUCTS, and forbidden
   * for ALL_PRODUCTS; the service enforces that pairing (it needs to check the
   * ids exist anyway) and reports it as a 400.
   */
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_SALE_TARGETS)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  targetIds?: string[];

  @IsDateString({}, { message: 'startAt must be an ISO 8601 date-time string' })
  startAt!: string;

  @IsOptional()
  @IsDateString({}, { message: 'endAt must be an ISO 8601 date-time string' })
  @Validate(SaleWindowConstraint)
  endAt?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /**
   * Which sale wins when several match one product — the ONLY business lever
   * over that choice. Higher wins; equal priority falls back to the older
   * campaign (then the lower id), purely so the outcome is deterministic.
   *
   * Discount size is deliberately NOT considered: a percentage and a fixed
   * amount cannot be compared without a price, so ranking by size would let the
   * winner change from product to product. Raise this to override.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000)
  priority?: number;
}
