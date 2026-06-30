import { IsOptional, IsString, IsObject } from 'class-validator';

/** Inputs for a delivery quote. All optional — a quote can be requested before
 * an address is chosen. Fields are accepted for forward-compatibility with
 * distance/zone-based pricing later. */
export class ShippingQuoteDto {
  @IsOptional()
  @IsString()
  delivery_address_id?: string;

  @IsOptional()
  @IsString()
  region_code?: string;

  @IsOptional()
  @IsObject()
  destination?: { lat?: number; lng?: number };
}
