import { IsString, IsOptional, Matches } from 'class-validator';
import { E164_REGEX } from './request-otp.dto';

export class ResendOtpDto {
  @IsString()
  request_id: string;

  @IsOptional()
  @Matches(E164_REGEX, { message: 'phone_e164 must be a valid E.164 number' })
  phone_e164?: string;
}
