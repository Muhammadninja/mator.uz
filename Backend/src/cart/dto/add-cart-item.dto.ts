import { IsString, IsOptional, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';

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
