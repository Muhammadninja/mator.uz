import { IsString, IsOptional, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

// Upper bound on a single cart line's quantity. A realistic retail cart never
// approaches this; the cap prevents absurd quantities from overflowing the
// line-total arithmetic or producing nonsensical order amounts.
export const MAX_CART_ITEM_QUANTITY = 999;

export class AddCartItemDto {
  // Catalog id of the part. The contract sends `id`; `part_id` is also accepted.
  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @IsString()
  part_id?: string;

  @IsOptional()
  @IsString()
  service_id?: string;

  @IsOptional()
  @IsString()
  provider_id?: string;

  @IsOptional()
  @IsString()
  vehicle_id?: string;

  @IsOptional()
  @IsString()
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
