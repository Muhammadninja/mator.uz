import { IsString, IsOptional, IsObject } from 'class-validator';

export class CreateOrderDto {
  // { items?, delivery_address_id?, delivery_method?, promo_code? }
  // Items are taken from the server-side cart (source of truth); the snapshot
  // is accepted for delivery/promo context.
  @IsOptional()
  @IsObject()
  cart_snapshot?: {
    delivery_address_id?: string;
    delivery_method?: string;
    promo_code?: string;
    items?: unknown[];
  };

  @IsOptional()
  @IsString()
  vehicle_id?: string;

  @IsOptional()
  @IsString()
  contact_phone_e164?: string;
}
