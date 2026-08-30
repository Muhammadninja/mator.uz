import { IsString, IsOptional, Matches, Length, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { E164_REGEX } from './request-otp.dto';
import { DeviceInfoDto } from './device-info.dto';
import { LegalAcceptanceInputDto } from './legal-acceptance.dto';

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

  /**
   * Legal consent. Optional on the DTO because this endpoint serves BOTH
   * registration and sign-in with one route: it is mandatory when the phone has
   * no account yet, and ignored for an existing account (which re-accepts via
   * POST /v1/legal/accept instead). PhoneAuthService enforces that distinction —
   * making it required here would lock out every existing user.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => LegalAcceptanceInputDto)
  legal?: LegalAcceptanceInputDto;
}
