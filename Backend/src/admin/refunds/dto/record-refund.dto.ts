import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RefundMethod } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const trimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** One seller's share of the goods a refund gives back. */
export class RefundAllocationDto {
  @ApiProperty({
    description: 'The seller (CatalogSeller id) as recorded on the order line.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  sellerId!: string;

  @ApiProperty({ description: 'How much of their goods went back, in UZS.' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(999_999_999_999.99)
  amountUzs!: number;
}

/** Body of POST /v1/admin/refunds/orders/:orderId. */
export class RecordRefundDto {
  @ApiProperty({ description: 'How much went back, in UZS.' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(999_999_999_999.99)
  amountUzs!: number;

  @ApiPropertyOptional({
    description:
      'How much of that is the service fee going back. None unless stated: a partial refund ' +
      'leaves the fee with Mator. A refund of all that is left needs no breakdown.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999.99)
  serviceFeeUzs?: number;

  @ApiPropertyOptional({
    description: 'How much of that is delivery going back. None unless stated.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999.99)
  deliveryUzs?: number;

  @ApiPropertyOptional({
    type: () => [RefundAllocationDto],
    description:
      'Whose goods the rest is for, per seller. Needed when the order has goods from more ' +
      'than one seller, unless the refund is all that is left.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => RefundAllocationDto)
  allocations?: RefundAllocationDto[];

  @ApiPropertyOptional({
    description:
      'The return receipt a cash register or the OFD issued for a refund made outside a provider.',
  })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  fiscalReference?: string;

  @ApiProperty({ enum: RefundMethod })
  @IsEnum(RefundMethod)
  method!: RefundMethod;

  @ApiProperty({
    description:
      'The document behind it: a provider transaction id, a cabinet record, a receipt.',
  })
  @Transform(trimmed)
  @IsString()
  @IsNotEmpty({ message: 'reference is required' })
  @MaxLength(120)
  reference!: string;

  @ApiProperty({ description: 'Why, for the audit trail.' })
  @Transform(trimmed)
  @IsString()
  @IsNotEmpty({ message: 'reason is required' })
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({
    description: 'When the money moved, if not just now. Never in the future.',
  })
  @IsOptional()
  @IsISO8601()
  refundedAt?: string;
}

/** Body of POST /v1/admin/refunds/:id/void. */
export class VoidRefundDto {
  @ApiProperty({ description: 'Why this entry was wrong.' })
  @Transform(trimmed)
  @IsString()
  @IsNotEmpty({ message: 'reason is required' })
  @MaxLength(500)
  reason!: string;
}

/** Query of GET /v1/admin/refunds. */
export class ListRefundsQueryDto {
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
  @IsEnum(RefundMethod)
  method?: RefundMethod;

  /** Voided entries are hidden unless asked for. */
  @IsOptional()
  @IsIn(['active', 'voided', 'all'])
  state?: 'active' | 'voided' | 'all';

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}
