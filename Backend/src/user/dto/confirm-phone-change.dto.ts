import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length, Matches } from 'class-validator';
import { E164_REGEX } from '../../auth/phone/dto/request-otp.dto';

/**
 * Body for POST /v1/me/phone/confirm. Confirms the OTP sent to `phone` by
 * POST /v1/me/phone/request and, on success, moves the account to that number.
 * The `otp` length range mirrors the sign-in verify DTO (4–8) so both flows
 * accept the same codes.
 */
export class ConfirmPhoneChangeDto {
  @ApiProperty({
    example: '+998901234567',
    description: 'The new phone number, same value sent to /phone/request.',
  })
  @Matches(E164_REGEX, { message: 'phone must be a valid E.164 number' })
  phone: string;

  @ApiProperty({
    example: '123456',
    description: 'The one-time code delivered to the new phone.',
  })
  @IsString()
  @Length(4, 8)
  otp: string;

  // Optional here so that an account with a phone gets the specific 403 from the
  // service. Required by the service whenever the account has a current number.
  @ApiPropertyOptional({
    example: '654321',
    description:
      'The one-time code delivered to the CURRENT phone. Required when the account has a phone number.',
  })
  @IsOptional()
  @IsString()
  @Length(4, 8)
  current_phone_otp?: string;
}
