import { IsString, IsOptional, IsObject, IsIn, Matches } from 'class-validator';

// E.164: +<country><number>, 7–15 digits total.
export const E164_REGEX = /^\+[1-9]\d{6,14}$/;

export class RequestOtpDto {
  @Matches(E164_REGEX, { message: 'phone_e164 must be a valid E.164 number' })
  phone_e164: string;

  @IsOptional()
  @IsString()
  country_iso2?: string;

  @IsOptional()
  @IsString()
  @IsIn(['sms', 'telegram'])
  channel?: string;

  // Accepted (and ignored server-side) so the client's analytics envelope and
  // captcha token don't trip forbidNonWhitelisted.
  @IsOptional()
  @IsObject()
  client?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  captcha_token?: string;
}
