import {
  IsString,
  IsOptional,
  IsObject,
  IsIn,
  IsInt,
  MaxLength,
  Min,
} from 'class-validator';

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

  // Chosen payment method. Optional for back-compat (older clients omit it);
  // persisted on the order so the payment webhook / reporting know the intent.
  // 'payme' = online, 'terminal' = card reader on delivery, 'cash' = COD.
  @IsOptional()
  @IsIn(['payme', 'terminal', 'cash'])
  payment_type?: 'payme' | 'terminal' | 'cash';

  // The courier price the buyer was shown and agreed to, from POST /v1/shipping/quote.
  // Compared against the price computed for the order and never charged from: see
  // OrdersService.createFromCart.
  @IsOptional()
  @IsInt()
  @Min(0)
  confirmed_delivery_uzs?: number;

  // The `quote_id` of that same answer: says which destination, pickup points and rates the
  // price was for. Compared against the quote computed for the order, never trusted.
  @IsOptional()
  @IsString()
  @MaxLength(128)
  delivery_quote_id?: string;
}
