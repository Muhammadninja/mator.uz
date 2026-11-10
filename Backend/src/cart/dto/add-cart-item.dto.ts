import {
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

// Upper bound on a single cart line's quantity. A realistic retail cart never
// approaches this; the cap prevents absurd quantities from overflowing the
// line-total arithmetic or producing nonsensical order amounts.
export const MAX_CART_ITEM_QUANTITY = 999;

export class AddCartItemDto {
  // Catalog id of the part. The contract sends `id`; `part_id` is also accepted.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  part_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  service_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  provider_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  vehicle_id?: string;

  // A real date-time, or 400: `new Date('garbage')` would otherwise reach the
  // database as Invalid Date and fail as a 500.
  // The extended form (`YYYY-MM-DDThh:mm…`) is the one `new Date()` parses; the
  // basic form `20261120` is valid ISO 8601 and would still become Invalid Date.
  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, {
    message: 'scheduled_at must be an ISO 8601 date-time',
  })
  scheduled_at?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_CART_ITEM_QUANTITY)
  quantity?: number;

  // Display fields the client may include — accepted (and ignored: price is
  // recomputed server-side from the catalog) so forbidNonWhitelisted passes.
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() price?: string;
  @IsOptional() @IsString() priceLabel?: string;
  @IsOptional() @IsString() badge?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() imageUrl?: string;
}
