import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { E164_REGEX } from '../../auth/phone/dto/request-otp.dto';

export class CreateBookingDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  vehicle_id?: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  service_ids: string[];

  // LOW-ORD-008: a real date-time, or 400. The extended form is the one
  // `new Date()` parses; anything else would reach the database as Invalid
  // Date and fail as a 500.
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, {
    message: 'scheduled_at must be an ISO 8601 date-time',
  })
  scheduled_at: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @Matches(E164_REGEX, { message: 'contact_phone_e164 must be a valid E.164 number' })
  contact_phone_e164: string;
}
