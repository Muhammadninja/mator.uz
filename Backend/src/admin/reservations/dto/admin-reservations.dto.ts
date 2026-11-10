import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const RESERVATION_VIEWS = [
  'active',
  'held',
  'allocated',
  'long_held',
  'needs_review',
  'return_pending',
  'released',
  'reconciled',
  'all',
] as const;
export type ReservationView = (typeof RESERVATION_VIEWS)[number];

export class ListReservationsQueryDto {
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
  @IsIn(RESERVATION_VIEWS)
  view?: ReservationView;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  orderId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  sellerId?: string;
}

export class ListShortagesQueryDto {
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
}

/** Every operator action on a reservation says why. */
export class ReservationActionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(400)
  reason!: string;
}

export class RestockReservationDto extends ReservationActionDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity!: number;
}
