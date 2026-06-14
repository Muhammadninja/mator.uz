import { IsString, IsOptional } from 'class-validator';

export class CreateInvoiceDto {
  @IsString()
  order_id: string;

  @IsOptional()
  @IsString()
  return_url?: string;
}
