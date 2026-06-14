import { IsString, IsOptional, IsArray, ArrayNotEmpty, Matches } from 'class-validator';

const E164 = /^\+[1-9]\d{6,14}$/;

export class CreateBookingDto {
  @IsOptional()
  @IsString()
  vehicle_id?: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  service_ids: string[];

  @IsString()
  scheduled_at: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @Matches(E164, { message: 'contact_phone_e164 must be a valid E.164 number' })
  contact_phone_e164: string;
}
