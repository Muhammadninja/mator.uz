import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PayoutMethod } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const trimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Body of POST /v1/admin/finance/sellers/:sellerId/payouts. */
export class RecordPayoutDto {
  @ApiProperty({ description: 'How much was sent to the seller, in UZS.' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(999_999_999_999.99)
  amountUzs!: number;

  @ApiProperty({ enum: PayoutMethod })
  @IsEnum(PayoutMethod)
  method!: PayoutMethod;

  @ApiProperty({
    description:
      'The document behind it: a payment order number, a cash receipt.',
  })
  @Transform(trimmed)
  @IsString()
  @IsNotEmpty({ message: 'reference is required' })
  @MaxLength(120)
  reference!: string;

  @ApiPropertyOptional({ description: 'Anything worth keeping with it.' })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({
    description: 'When the money moved, if not just now. Never in the future.',
  })
  @IsOptional()
  @IsISO8601()
  paidAt?: string;
}

/** Body of POST /v1/admin/finance/payouts/:id/void. */
export class VoidPayoutDto {
  @ApiProperty({ description: 'Why this entry was wrong.' })
  @Transform(trimmed)
  @IsString()
  @IsNotEmpty({ message: 'reason is required' })
  @MaxLength(500)
  reason!: string;
}

/** Query of GET /v1/admin/finance/fiscal-issues. */
export class FiscalIssuesQueryDto {
  /**
   * How long Payme gets to report a receipt before its absence counts. SetFiscalData is a
   * callback Payme sends some time after the payment, and it may not send it at all.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(7 * 24 * 60)
  graceMinutes?: number;
}

/** Body of POST /v1/admin/finance/orders/:orderId/payout-hold[/release]. */
export class PayoutHoldDto {
  @ApiProperty({
    description:
      'Why: the cancellation or return under way, or how it was settled.',
  })
  @Transform(trimmed)
  @IsString()
  @IsNotEmpty({ message: 'reason is required' })
  @MaxLength(500)
  reason!: string;
}

/** Query of GET /v1/admin/finance/payme-statement: Payme's own window, in milliseconds. */
export class StatementQueryDto {
  @ApiProperty({
    description: 'From, in ms since the epoch, as Payme sends it.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  from!: number;

  @ApiProperty({
    description: 'To, in ms since the epoch. At most 92 days after from.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  to!: number;
}
