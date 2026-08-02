import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsOptional,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * Body of PATCH /v1/admin/products/:id/rating.
 *
 * Ratings are CURATED admin data, not user reviews — an operator types both
 * numbers by hand. The global ValidationPipe runs with `whitelist: true,
 * forbidNonWhitelisted: true`, so this class IS the accepted-field whitelist and
 * an unknown key is a 400.
 *
 * `ratingAvg` is `number | null`: null clears the rating ("not rated"), which is
 * deliberately distinct from 0 ("rated zero"). `@ValidateIf(v => v !== null)`
 * rather than `@IsOptional()` is what makes that distinction expressible —
 * `@IsOptional()` treats an explicit null as "absent" and would silently skip
 * the range checks, letting a null slip past on a field that must be validated
 * when it carries a number.
 *
 * Both fields are optional so an operator can edit one without restating the
 * other. This DTO is the single enforcement point for the 0–5 bound (see the
 * migration for why no database CHECK backs it); the column's own NUMERIC(2,1)
 * scale independently makes a second decimal place unstorable.
 */
export class UpdateProductRatingDto {
  @ApiPropertyOptional({
    description:
      'Average rating, 0.0–5.0 with at most ONE decimal place (Decimal(2,1)). ' +
      'Explicit null clears the rating — distinct from 0, which means "rated zero".',
    example: 4.7,
    nullable: true,
    type: Number,
  })
  // Absent → not written. Explicitly null → cleared. A number → range-checked.
  @ValidateIf((_o, value) => value !== null)
  @IsOptional()
  @Type(() => Number)
  // maxDecimalPlaces: 1 enforces the Decimal(2,1) contract at the edge, so 4.75
  // is a 400 rather than a value silently rounded on the way into the column.
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  @Max(5)
  ratingAvg?: number | null;

  @ApiPropertyOptional({
    description: 'Number of ratings behind the average (non-negative integer).',
    example: 123,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  reviewCount?: number;
}

/** Documented response of the rating update (the persisted values). */
export class ProductRatingResponseDto {
  @ApiProperty({ example: 12 })
  id!: number;

  @ApiProperty({ example: 4.7, nullable: true, type: Number })
  ratingAvg!: number | null;

  @ApiProperty({ example: 123 })
  reviewCount!: number;
}
