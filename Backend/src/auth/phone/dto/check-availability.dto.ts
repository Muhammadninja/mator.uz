import { IsString, IsOptional, IsObject, Matches } from 'class-validator';
import { E164_REGEX } from './request-otp.dto';

export class CheckAvailabilityDto {
  @Matches(E164_REGEX, { message: 'phone_e164 must be a valid E.164 number' })
  phone_e164: string;

  @IsOptional()
  @IsString()
  country_iso2?: string;

  @IsOptional()
  @IsObject()
  client?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  captcha_token?: string;
}
