import { IsIn, IsOptional, IsString } from 'class-validator';

/**
 * Inputs for a delivery quote. There is deliberately no place for coordinates or a price:
 * the destination is always the saved address and the price is always computed here, so
 * nothing in this body can change what the buyer is charged.
 */
export class ShippingQuoteDto {
  @IsOptional()
  @IsString()
  delivery_address_id?: string;

  /** 'courier' asks for the courier price, which needs a delivery address. */
  @IsOptional()
  @IsIn(['courier', 'pickup'])
  delivery_method?: 'courier' | 'pickup';
}
