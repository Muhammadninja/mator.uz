import { IsString, IsOptional, MaxLength, IsNotEmpty } from 'class-validator';

export class CreateInvoiceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  order_id: string;

  /**
   * Where the provider sends the buyer back to. Shape only here; whether the
   * address is one of ours is decided by the return-URL policy in
   * PaymentsService (payment-return-url.ts).
   */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  return_url?: string;
}
