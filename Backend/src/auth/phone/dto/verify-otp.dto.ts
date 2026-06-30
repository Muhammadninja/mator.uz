import { IsString, IsOptional, Matches, Length, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { E164_REGEX } from './request-otp.dto';
import { DeviceInfoDto } from './device-info.dto';

export class VerifyOtpDto {
  @IsString()
  request_id: string;

  @Matches(E164_REGEX, { message: 'phone_e164 must be a valid E.164 number' })
  phone_e164: string;

  @IsString()
  @Length(4, 8)
  otp_code: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => DeviceInfoDto)
  device?: DeviceInfoDto;
}
